import { sleep, jitter, createLogger, VintedError } from './util.js';
import { DOMAIN_LOCALES } from './lookup.js';
import { isSessionRefreshPage } from './flight.js';

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];

const SESSION_MAX_AGE_MS = 20 * 3600 * 1000; // access_token_web is valid 24h; refresh early.

/**
 * Low-level HTTP client for Vinted: cookie jar, anonymous session bootstrap, polite throttling,
 * retries with exponential back-off, and automatic session refresh on 401/403/"Session refresh".
 *
 * Proxy: set `NODE_USE_ENV_PROXY=1` plus `HTTPS_PROXY=...` in the environment (Node ≥ 24) and
 * global fetch will route through it. Cookies from a logged-in browser can be injected via the
 * `cookie` option (or `VINTED_COOKIE`) for endpoints that need an account.
 */
export class VintedClient {
  constructor({
    domain = 'hr',
    baseUrl,
    userAgent,
    cookie = process.env.VINTED_COOKIE,
    minDelayMs = 1200,
    maxRetries = 4,
    timeoutMs = 30000,
    locale,
    logger = createLogger(process.env.VINTED_LOG ?? 'info'),
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.domain = domain;
    this.baseUrl = (baseUrl ?? `https://www.vinted.${domain}`).replace(/\/$/, '');
    this.userAgent = userAgent ?? USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    this.locale = locale ?? DOMAIN_LOCALES[domain] ?? 'en-US';
    this.minDelayMs = minDelayMs;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.jar = new Map();
    this.sessionAt = 0;
    this.lastRequestAt = 0;
    this.stats = { requests: 0, retries: 0, sessionRefreshes: 0, cooldowns: 0 };
    this.consecutive429 = 0;
    if (cookie) this.importCookies(cookie);
  }

  importCookies(cookieHeader) {
    for (const part of String(cookieHeader).split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i > 0) this.jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    if (this.jar.has('access_token_web')) this.sessionAt = Date.now();
  }

  absorbCookies(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (i < 0) continue;
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1);
      // Vinted sometimes sends the same cookie twice in one response (empty then real): last wins.
      if (v === '') this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  baseHeaders(extra = {}) {
    return {
      'user-agent': this.userAgent,
      'accept-language': `${this.locale},${this.locale.slice(0, 2)};q=0.9,en;q=0.8`,
      cookie: this.cookieHeader(),
      ...extra,
    };
  }

  async throttle(factor = 1) {
    const wait = this.lastRequestAt + jitter(this.minDelayMs * factor) - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  /** Fetches the homepage to obtain anonymous session cookies (access_token_web, datadome, …). */
  async ensureSession({ force = false } = {}) {
    if (!force && this.jar.has('access_token_web') && Date.now() - this.sessionAt < SESSION_MAX_AGE_MS) return;
    this.logger.debug(`bootstrapping session on ${this.baseUrl}`);
    await this.throttle();
    const res = await this.fetch(`${this.baseUrl}/`, {
      headers: this.baseHeaders({ accept: 'text/html,application/xhtml+xml' }),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.stats.requests++;
    this.absorbCookies(res);
    await res.arrayBuffer().catch(() => {});
    if (!this.jar.has('access_token_web')) {
      throw new VintedError(`Could not obtain a Vinted session from ${this.baseUrl} (HTTP ${res.status}). You may be blocked; try a proxy or pass browser cookies.`, { code: 'NO_SESSION', status: res.status });
    }
    this.sessionAt = Date.now();
    this.stats.sessionRefreshes++;
  }

  /**
   * Performs a throttled GET with retries. Returns `{ status, text, headers }`.
   * Session refresh is triggered on 401/403 and when Vinted serves its "Session refresh" page.
   */
  async get(path, { headers = {}, expect = 'text' } = {}) {
    await this.ensureSession();
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    let attempt = 0;
    // The JSON endpoints (seller profiles, brands) rate-limit much sooner than page loads: go at half speed there.
    const pace = /\/api\/v2\//.test(url) ? 2 : /\/items\/\d+/.test(url) ? 2.5 : 1;
    for (;;) {
      await this.throttle(pace);
      let res;
      try {
        res = await this.fetch(url, { headers: this.baseHeaders(headers), redirect: 'follow', signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        if (attempt >= this.maxRetries) throw new VintedError(`Network error fetching ${url}: ${err.message}`, { code: 'NETWORK', cause: err });
        await this.backoff(++attempt, `network error: ${err.message}`);
        continue;
      }
      this.stats.requests++;
      this.absorbCookies(res);
      const text = await res.text();
      if (res.status === 429) {
        // Several 429s in a row means the IP is being throttled: stop hammering and cool down.
        if (++this.consecutive429 >= 3) {
          const cool = jitter(120000, 0.25);
          this.stats.cooldowns++;
          this.logger.warn(`${this.consecutive429} consecutive 429s; cooling down ${Math.round(cool / 1000)}s`);
          await sleep(cool);
          this.consecutive429 = 0;
        }
      } else if (res.status < 500) this.consecutive429 = 0;
      const retriable = res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500 || (res.ok && expect === 'text' && isSessionRefreshPage(text));
      if (!retriable) return { status: res.status, text, headers: res.headers, url: res.url };
      if (attempt >= this.maxRetries) {
        const code = res.status === 403 || res.status === 429 ? 'BLOCKED' : isSessionRefreshPage(text) ? 'SESSION_REFRESH' : 'HTTP';
        throw new VintedError(`Giving up on ${url} after ${attempt + 1} attempts (last HTTP ${res.status}).`, { code, status: res.status });
      }
      attempt++;
      if (res.status === 401 || res.status === 403 || isSessionRefreshPage(text)) {
        this.logger.debug(`session invalid (HTTP ${res.status}); refreshing`);
        await this.ensureSession({ force: true }).catch((e) => this.logger.warn(e.message));
      }
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      await this.backoff(attempt, `HTTP ${res.status}`, Math.max(retryAfter || 0, res.status === 429 ? 8000 * attempt : 0));
    }
  }

  async backoff(attempt, reason, minMs = 0) {
    this.stats.retries++;
    const ms = Math.max(minMs || 0, jitter(1500 * 2 ** attempt));
    this.logger.warn(`retry ${attempt}/${this.maxRetries} in ${(ms / 1000).toFixed(1)}s (${reason})`);
    await sleep(ms);
  }

  /** RSC flight payload for a page (much smaller than the HTML). Falls back to HTML automatically. */
  async getFlight(path) {
    const res = await this.get(path, { headers: { accept: '*/*', rsc: '1' } });
    if (res.status === 404) throw new VintedError(`Not found: ${path}`, { code: 'NOT_FOUND', status: 404 });
    if (!/text\/x-component/.test(res.headers.get('content-type') ?? '')) {
      this.logger.debug(`non-flight response for ${path}; using HTML fallback`);
      return this.getHtml(path);
    }
    return res.text;
  }

  async getHtml(path) {
    const res = await this.get(path, { headers: { accept: 'text/html,application/xhtml+xml' } });
    if (res.status === 404) throw new VintedError(`Not found: ${path}`, { code: 'NOT_FOUND', status: 404 });
    return res.text;
  }

  async getJson(path) {
    const res = await this.get(path, { headers: { accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest' }, expect: 'json' });
    let body;
    try {
      body = JSON.parse(res.text);
    } catch {
      throw new VintedError(`Expected JSON from ${path} but got HTTP ${res.status} ${res.text.slice(0, 80).replace(/\s+/g, ' ')}…`, { code: 'PARSE', status: res.status });
    }
    if (res.status >= 400) throw new VintedError(`HTTP ${res.status} from ${path}: ${body.message ?? body.message_code ?? ''}`, { code: res.status === 404 ? 'NOT_FOUND' : 'HTTP', status: res.status });
    return body;
  }
}
