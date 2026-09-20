import { VintedClient } from './client.js';
import { buildCatalogUrl, parseCatalogFlight, normalizeItem } from './catalog.js';
import { parseItemFlight, parseItemId } from './item.js';
import { normalizeUser } from './users.js';
import { resolveCondition, resolveColor, flattenCatalogs, bestMatch } from './lookup.js';
import { createLogger, VintedError } from './util.js';
import { Geocoder, locateItems, resolveNear } from './geo.js';
import { findObjectAfterKey, unwrapHtmlFlight } from './flight.js';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const MAX_SITE_PAGES = 10; // Vinted caps any search at 10 pages × 96 items.

/**
 * Builds a predicate from optional include/exclude patterns (regex strings or arrays of them,
 * case-insensitive) applied to the listing title and brand. Lets a search like "air max 90"
 * drop t-shirts and jerseys that Vinted's relevance ranking mixes in.
 */
const prune = (n) => ({ id: n.id, title: n.title, url: n.url, catalogs: (n.catalogs ?? []).map(prune) });

export function titleFilter(include, exclude) {
  const toRe = (p) => (p === undefined || p === null || p === '' ? [] : (Array.isArray(p) ? p : [p]).map((x) => (x instanceof RegExp ? x : new RegExp(x, 'i'))));
  const inc = toRe(include);
  const exc = toRe(exclude);
  if (!inc.length && !exc.length) return () => true;
  return (item) => {
    const hay = `${item.title ?? ''} ${item.brand ?? ''}`;
    return inc.every((re) => re.test(hay)) && !exc.some((re) => re.test(hay));
  };
}

/**
 * High-level facade. Everything the CLI does is available programmatically:
 *
 *   const v = new VintedScraper({ domain: 'hr' });
 *   const { items } = await v.search({ query: 'nike air max', priceTo: 40 }, { pages: 2 });
 */
export class VintedScraper {
  constructor(options = {}) {
    this.logger = options.logger ?? createLogger(options.logLevel ?? process.env.VINTED_LOG ?? 'info');
    this.client = options.client ?? new VintedClient({ ...options, logger: this.logger });
    this.baseUrl = this.client.baseUrl;
    this.store = options.store; // optional Store used for seller/geocode caches
    this.geocoder = options.geocoder ?? new Geocoder({ store: this.store, logger: this.logger });
    this._catalogs = undefined;
  }

  /** Fetches one catalog page. */
  async searchPage(params, page = 1) {
    const url = buildCatalogUrl(this.baseUrl, { ...params, page });
    this.logger.debug(`GET ${url}`);
    const text = await this.client.getFlight(url);
    const { items, pagination, tracking } = parseCatalogFlight(text);
    return { items: items.map((raw) => normalizeItem(raw, this.baseUrl)), pagination, tracking, url };
  }

  /**
   * Iterates catalog pages, yielding `{ items, pagination, page }` until `pages` are fetched,
   * the site reports no more pages, or `stopWhen(item)` returns true for an item (e.g. an id
   * already seen when ordering by newest).
   */
  async *searchPages(params, { pages = 1, stopWhen } = {}) {
    const limit = Math.min(pages ?? 1, MAX_SITE_PAGES);
    for (let page = 1; page <= limit; page++) {
      const result = await this.searchPage(params, page);
      let items = result.items;
      let stop = false;
      if (stopWhen) {
        const idx = items.findIndex(stopWhen);
        if (idx >= 0) {
          items = items.slice(0, idx);
          stop = true;
        }
      }
      yield { ...result, items, page };
      if (stop || !items.length || page >= result.pagination.totalPages) return;
    }
  }

  /**
   * Runs a search across up to `pages` pages and returns de-duplicated listings.
   * @param {import('./catalog.js').SearchParams & FriendlyParams} params
   */
  /**
   * Resolves a `--near` style location (place name or "lat,lon") into a reference for {@link search}.
   * Country defaults to the geocoded country of the place, so "Wien" implies Austria.
   */
  async near(input, { radiusKm = 50, strict = false, countryCode } = {}) {
    return resolveNear(input, { geocoder: this.geocoder, radiusKm, strict, countryCode });
  }

  /** Annotates listings with seller location and keeps those within `near.radiusKm`. */
  async locate(items, near, opts = {}) {
    return locateItems(items, { scraper: this, store: this.store, geocoder: this.geocoder, near, ...opts });
  }

  async search(params, { pages = 1, limit, stopWhen, enrich = false, seller = false, concurrency = 2, near } = {}) {
    const resolved = await this.resolveParams(params);
    const keep = titleFilter(resolved.include, resolved.exclude);
    delete resolved.include; delete resolved.exclude;
    const seen = new Map();
    let pagination;
    let pagesFetched = 0;
    for await (const pageResult of this.searchPages(resolved, { pages, stopWhen })) {
      pagination = pageResult.pagination;
      pagesFetched++;
      for (const it of pageResult.items) if (keep(it) && !seen.has(it.id)) seen.set(it.id, it);
      if (limit && !near && seen.size >= limit) break;
    }
    let items = [...seen.values()];
    if (near) {
      const before = items.length;
      items = await this.locate(items, near);
      const hidden = items.filter((i) => i.location?.status === 'unknown').length;
      this.logger.info(`location: ${items.length} of ${before} listings kept within ${near.radiusKm} km of ${near.name}${hidden ? ` (${hidden} with city hidden)` : ''}`);
    }
    if (limit) items = items.slice(0, limit);
    if (enrich || seller) items = await this.enrich(items, { details: enrich, seller, concurrency });
    return { items, pagination, pagesFetched, params: resolved };
  }

  /** Full item detail (description, attributes, seller, shipping, flags). */
  async item(idOrUrl) {
    const id = parseItemId(idOrUrl);
    const text = await this.client.getFlight(`/items/${id}`);
    return parseItemFlight(text, this.baseUrl);
  }

  /** Public seller profile via Vinted's JSON API. */
  async user(id) {
    const raw = await this.client.getJson(`/api/v2/users/${Number(id)}`);
    return normalizeUser(raw, this.baseUrl);
  }

  /** Brand search via Vinted's JSON API; returns [{ id, title, slug, itemCount }]. */
  async brands(keyword, { perPage = 20 } = {}) {
    const raw = await this.client.getJson(`/api/v2/brands?keyword=${encodeURIComponent(keyword)}&per_page=${perPage}`);
    return (raw.brands ?? []).map((b) => ({ id: b.id, title: b.title, slug: b.slug, itemCount: b.item_count, favouriteCount: b.favourite_count }));
  }

  /**
   * Full category tree with local titles and English URL slugs, taken from the catalog page
   * payload (the JSON upload API lacks slugs). Cached in memory and on disk for 7 days.
   */
  async catalogs({ flat = true } = {}) {
    if (!this._catalogs) {
      const cacheDir = process.env.VINTED_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir() || tmpdir(), '.cache'), 'vinted-scraper');
      const cacheFile = join(cacheDir, `catalogs-${this.client.domain}.json`);
      try {
        if (Date.now() - statSync(cacheFile).mtimeMs < 7 * 864e5) this._catalogs = JSON.parse(readFileSync(cacheFile, 'utf8'));
      } catch { /* no cache */ }
      if (!this._catalogs) {
        const text = unwrapHtmlFlight(await this.client.getFlight('/catalog'));
        const tree = findObjectAfterKey(text, '"catalogTree":[');
        if (!Array.isArray(tree) || !tree.length) throw new VintedError('Could not read the category tree from the catalog page.', { code: 'PARSE' });
        this._catalogs = tree.map(prune);
        try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cacheFile, JSON.stringify(this._catalogs)); } catch { /* cache is best-effort */ }
      }
    }
    return flat ? flattenCatalogs(this._catalogs) : this._catalogs;
  }

  /**
   * Accepts friendly params (`brand: 'nike'`, `category: 'trainers'`, `condition: ['new','good']`,
   * `color: 'black'`) alongside raw id arrays and returns pure {@link SearchParams}.
   * @typedef {object} FriendlyParams
   * @property {string|string[]|number|number[]} [brand]
   * @property {string|string[]|number|number[]} [category]
   * @property {string|string[]|number|number[]} [condition]
   * @property {string|string[]|number|number[]} [color]
   */
  async resolveParams(params = {}) {
    const out = { ...params };
    const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
    delete out.brand; delete out.category; delete out.condition; delete out.color;

    const brandIds = [...(params.brandIds ?? [])];
    for (const b of list(params.brand)) {
      if (/^\d+$/.test(String(b))) { brandIds.push(Number(b)); continue; }
      const candidates = await this.brands(b);
      const match = bestMatch(candidates, b);
      if (!match) throw new VintedError(`No Vinted brand matches ${JSON.stringify(b)}`, { code: 'BAD_INPUT' });
      this.logger.debug(`brand ${JSON.stringify(b)} → ${match.title} (${match.id})`);
      brandIds.push(match.id);
    }
    if (brandIds.length) out.brandIds = brandIds;

    const catalogIds = [...(params.catalogIds ?? [])];
    for (const c of list(params.category)) {
      if (/^\d+$/.test(String(c))) { catalogIds.push(Number(c)); continue; }
      const all = await this.catalogs();
      const match = bestMatch(all, c, ['title', 'slug', 'path']);
      if (!match) throw new VintedError(`No Vinted category matches ${JSON.stringify(c)}`, { code: 'BAD_INPUT' });
      this.logger.debug(`category ${JSON.stringify(c)} → ${match.path} (${match.id})`);
      catalogIds.push(match.id);
    }
    if (catalogIds.length) out.catalogIds = catalogIds;

    const statusIds = [...(params.statusIds ?? []), ...list(params.condition).map(resolveCondition)];
    if (statusIds.length) out.statusIds = [...new Set(statusIds)];
    const colorIds = [...(params.colorIds ?? []), ...list(params.color).map(resolveColor)];
    if (colorIds.length) out.colorIds = [...new Set(colorIds)];
    return out;
  }

  /** Adds `detail` and/or `sellerProfile` to listings, with bounded concurrency. */
  async enrich(items, { details = true, seller = false, concurrency = 2 } = {}) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        const it = { ...items[i] };
        if (details) {
          try { it.detail = await this.item(it.id); } catch (e) { it.detailError = e.message; this.logger.warn(`item ${it.id}: ${e.message}`); }
        }
        if (seller && it.sellerId) {
          try { it.sellerProfile = await this.user(it.sellerId); } catch (e) { it.sellerError = e.message; this.logger.warn(`user ${it.sellerId}: ${e.message}`); }
        }
        out[i] = it;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
    return out;
  }
}
