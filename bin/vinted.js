#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { VintedScraper } from '../src/scraper.js';
import { Store } from '../src/store.js';
import { scoreDeals } from '../src/deals.js';
import { watch } from '../src/watch.js';
import { createNotifier } from '../src/notify.js';
import { createDashboard } from '../src/server.js';
import { createVisionClient, analyzeListing, normalizeVerdict } from '../src/vision.js';
import { loadRules, buyScore, fitsMySize, brandTier as brandTierOf_, priceFloor } from '../src/rules.js';
const brandTierOf = (b) => brandTierOf_(b, MY_SIZE_RULES);
import { evaluateListings } from '../src/buyer.js';
import { formatTable, writeOutput } from '../src/export.js';
import { CONDITIONS, COLORS, ORDERS } from '../src/lookup.js';
import { createLogger } from '../src/util.js';
import { formatLocation } from '../src/geo.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

const HELP = `vinted — smart Vinted scraper (search, item details, sellers, deals, watch)

Usage:
  vinted search <query> [filters] [output]      search listings
  vinted deals  <query> [filters] [output]      search, score, and rank bargains
  vinted item   <id|url> [--seller]             full item detail (+ seller profile)
  vinted hunt   [--brand …] [--tier 1|2|all]    sweep luxury brands, triage by text, photo-check the best, rank buys (--from-db reuses the last sweep)
  vinted recheck [--min-buy 50]                 re-visit strong buys: still available, reserved, sold or removed? (the paper-trading test)
  vinted rescore [--db file] [--rules file]     recompute buy scores from stored verdicts (no model calls)
  vinted analyze <id|url> [--force]              vision verdict + resale buy score for one listing (--force ignores the cache)
  vinted user   <id>                            seller profile
  vinted brands <keyword>                       resolve brand names → ids
  vinted catalogs [keyword]                     list/search category tree
  vinted watch  [--config file] [filters]       poll saved searches, alert on new/price drops
  vinted init                                   write vinted.config.json with an example
  vinted serve  [--db file] [--port 3210] [--host 0.0.0.0 --password …]   dashboard (password required off-localhost)

Filters:
  --brand <name|id>        repeatable            --category <name|id>   repeatable
  --condition <name|id>    repeatable            --color <name|id>      repeatable
  --size-id <id>           repeatable            --min <price>  --max <price>
  --order newest|relevance|price_asc|price_desc  --currency EUR
  --include <regex>        repeatable; title must match all
  --exclude <regex>        repeatable; drop titles matching any
  --near <place|lat,lon>   keep sellers within --radius km (default 50) of a place, e.g. --near Wien
  --strict-location        with --near: also drop sellers who hide their city
  --pages <n> (max 10)     --limit <n>

AI buying assistant (OpenRouter, default model qwen/qwen3.8-flash; needs OPENROUTER_API_KEY):
  --ai                     run vision verdicts + buy score on the best candidates
  --ai-model <id>          any OpenAI-compatible vision model id     --ai-max <n>  listings per run (default 30)
  --rules <file>           your resale rules (brands, sizes, fees); see src/rules.default.json
  --min-buy <n>            only show/alert listings with buy score ≥ n   --all-brands  evaluate non-luxury brands too
  --my-size                only listings that fit rules.mySizes (shoes, clothing, trousers)
  --min-upside <ratio>     hunt: photo-check triage picks whose (est resale - price)/price ≥ ratio (default 0.5)
  --analyze-picks          hunt: photo-check stored triage picks that have no verdict yet (no search, no triage)

Enrichment / scoring:
  --enrich                 fetch item detail for every result (slower)
  --seller                 fetch seller profile for every result
  --score                  add deal score (search); --min-score <n> filter by it
  --db <file>              record results in SQLite (enables history-based scoring & dedupe)

Output:
  --format table|json|ndjson|csv  (default: table on a TTY, json otherwise)
  --out <file>             write output to a file instead of stdout
  --new-only               with --db: only print listings not seen before

Watch:
  --config <file>          JSON with { searches: [...], intervalSec, webhook, mac, db, minScore }
  --interval <sec>         poll interval (default 120)      --once   single pass
  --webhook <url>          Discord / Slack / generic JSON   --mac    macOS notification
  --telegram-token <t> --telegram-chat <id> --telegram-min-score <n>   Telegram push for deals scoring ≥ n (default 60)
  --notify-first-run       alert on the seeding pass too

Global:
  --domain hr|fr|de|com|co.uk|pl|it|es|nl|...   (default hr, or VINTED_DOMAIN)
  --cookie "<cookie header>"   use cookies from your browser (or VINTED_COOKIE)
  --proxy <url>                route through an HTTP(S) proxy
  --delay <ms>                 min delay between requests (default 1200)
  --verbose / --quiet          logging

Conditions: ${Object.entries(CONDITIONS).map(([k, v]) => `${v} (${k})`).join(', ')}
Orders:     ${[...new Set(Object.values(ORDERS))].join(', ')}
`;

const options = {
  domain: { type: 'string' }, cookie: { type: 'string' }, proxy: { type: 'string' }, delay: { type: 'string' },
  verbose: { type: 'boolean', short: 'v' }, quiet: { type: 'boolean', short: 'q' }, help: { type: 'boolean', short: 'h' },
  brand: { type: 'string', multiple: true }, category: { type: 'string', multiple: true }, condition: { type: 'string', multiple: true },
  color: { type: 'string', multiple: true }, 'size-id': { type: 'string', multiple: true },
  min: { type: 'string' }, max: { type: 'string' }, order: { type: 'string' }, currency: { type: 'string' },
  pages: { type: 'string' }, limit: { type: 'string' },
  enrich: { type: 'boolean' }, seller: { type: 'boolean' }, score: { type: 'boolean' }, 'min-score': { type: 'string' },
  db: { type: 'string' }, 'new-only': { type: 'boolean' },
  format: { type: 'string', short: 'f' }, out: { type: 'string', short: 'o' },
  config: { type: 'string', short: 'c' }, interval: { type: 'string' }, once: { type: 'boolean' }, webhook: { type: 'string' },
  mac: { type: 'boolean' }, 'notify-first-run': { type: 'boolean' }, name: { type: 'string' },
  concurrency: { type: 'string' }, include: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true },
  near: { type: 'string' }, radius: { type: 'string' }, 'strict-location': { type: 'boolean' }, port: { type: 'string' },
  host: { type: 'string' }, password: { type: 'string' },
  'telegram-token': { type: 'string' }, 'telegram-chat': { type: 'string' }, 'telegram-min-score': { type: 'string' },
  ai: { type: 'boolean' }, force: { type: 'boolean' }, 'my-size': { type: 'boolean' }, tier: { type: 'string' }, 'from-db': { type: 'boolean' }, 'min-upside': { type: 'string' }, 'analyze-picks': { type: 'boolean' }, triage: { type: 'boolean' }, 'no-triage': { type: 'boolean' }, 'ai-model': { type: 'string' }, 'ai-max': { type: 'string' }, rules: { type: 'string' }, 'min-buy': { type: 'string' }, 'all-brands': { type: 'boolean' },
};

function fail(msg, code = 1) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

function intOpt(v, name, { min = 1, max = Infinity } = {}) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be an integer between ${min} and ${max}`);
  return n;
}

function numOpt(v, name) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(`--${name} must be a non-negative number`);
  return n;
}

function searchParamsFromFlags(v, query) {
  return {
    query: query || undefined,
    brand: v.brand, category: v.category, condition: v.condition, color: v.color,
    sizeIds: v['size-id']?.map(Number),
    priceFrom: numOpt(v.min, 'min'), priceTo: numOpt(v.max, 'max'),
    order: v.order, currency: v.currency,
    include: v.include, exclude: v.exclude,
  };
}

const LIST_COLUMNS = ['id', 'price', 'currency', 'brand', 'size', 'condition', 'title', 'url'];

let MY_SIZE_RULES;
function output(rows, v, columns = LIST_COLUMNS) {
  if (v['my-size'] && MY_SIZE_RULES) rows = rows.filter((r) => fitsMySize(r, MY_SIZE_RULES));
  const format = v.format ?? (process.stdout.isTTY && !v.out ? 'table' : 'json');
  if (format === 'table') {
    process.stdout.write(formatTable(rows, columns) + '\n');
    return;
  }
  writeOutput(rows, { format, out: v.out });
  if (v.out) process.stderr.write(`wrote ${rows.length} rows to ${v.out}\n`);
}

async function main() {
  try { process.loadEnvFile('.env'); } catch { /* no .env file */ }
  const { values: v, positionals } = parseArgs({ options, allowPositionals: true, strict: true });
  const [command, ...rest] = positionals;
  if (v.help || !command) {
    process.stdout.write(HELP);
    return;
  }
  if (v.proxy && process.env.NODE_USE_ENV_PROXY !== '1') {
    // Node's fetch honours HTTPS_PROXY only when NODE_USE_ENV_PROXY is set at startup: re-exec.
    const child = spawn(process.execPath, process.execArgv.concat(process.argv.slice(1)), {
      stdio: 'inherit',
      env: { ...process.env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: v.proxy, HTTP_PROXY: v.proxy },
    });
    child.on('exit', (code) => process.exit(code ?? 1));
    return;
  }

  const logger = createLogger(v.verbose ? 'debug' : v.quiet ? 'error' : process.env.VINTED_LOG ?? 'info');
  const scraper = new VintedScraper({
    domain: v.domain ?? process.env.VINTED_DOMAIN ?? 'hr',
    cookie: v.cookie ?? process.env.VINTED_COOKIE,
    minDelayMs: intOpt(v.delay, 'delay', { min: 0 }) ?? 1200,
    logger,
  });
  const pages = intOpt(v.pages, 'pages', { max: 10 }) ?? 1;
  const limit = intOpt(v.limit, 'limit');
  const concurrency = intOpt(v.concurrency, 'concurrency', { max: 8 }) ?? 4;
  const minScore = numOpt(v['min-score'], 'min-score') ?? 0;
  // Seller profiles and geocoding results are cached in SQLite: the --db file if given, else a shared cache.
  const cacheDir = process.env.VINTED_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'vinted-scraper');
  // Default to the project's vinted.db when it exists (so analyze/hunt/watch share verdicts), else a shared cache.
  const openStore = (path) => { if (!path) { if (existsSync('vinted.db')) path = 'vinted.db'; else { mkdirSync(cacheDir, { recursive: true }); path = join(cacheDir, 'cache.db'); } } return new Store(path); };
  const radius = numOpt(v.radius, 'radius') ?? 50;
  const rules = loadRules(v.rules ?? (existsSync('rules.json') ? 'rules.json' : undefined));
  MY_SIZE_RULES = rules;
  const aiMax = intOpt(v['ai-max'], 'ai-max') ?? 30;
  const minBuy = numOpt(v['min-buy'], 'min-buy');
  const vision = (model) => createVisionClient({ model: model ?? v['ai-model'], logger, pricePerMillion: { prompt: 0.15, completion: 0.47 } });
  const nearFor = async (input) => (input ? scraper.near(input, { radiusKm: radius, strict: Boolean(v['strict-location']) }) : undefined);

  switch (command) {
    case 'search':
    case 'deals': {
      const query = rest.join(' ');
      const params = searchParamsFromFlags(v, query);
      if (!query && !v.brand && !v.category) fail('search needs a query or at least --brand/--category');
      if (command === 'deals' && !v.order) params.order = 'relevance';
      const store = openStore(v.db);
      scraper.store = store; scraper.geocoder.store = store;
      const near = await nearFor(v.near);
      if (near) logger.info(`location filter: within ${near.radiusKm} km of ${near.name} (${near.countryCode ?? 'any country'})${near.strict ? ', strict' : ''}`);
      const { items: found, pagination } = await scraper.search(params, { pages, limit: command === 'deals' ? undefined : limit, enrich: v.enrich, seller: v.seller, concurrency, near });
      let items = found;
      let baseline = {};
      if (v.db) {
        baseline = store.baseline();
        const { newItems } = store.recordSeen(v.name ?? (query || JSON.stringify(params)), items);
        if (v['new-only']) items = newItems;
        logger.info(`db: ${newItems.length} new of ${found.length}; ${store.count()} listings tracked`);
      }
      let columns = near ? [...LIST_COLUMNS.slice(0, 6), 'location', 'title', 'url'] : LIST_COLUMNS;
      if (near) items = items.map((i) => ({ ...i, location: { ...i.location, toString: undefined }, locationText: formatLocation(i.location) }));
      if (command === 'deals' || v.score) {
        items = scoreDeals(items, { baseline, sort: true }).filter((i) => i.deal.score >= minScore);
        columns = near ? ['deal.score', 'price', 'currency', 'deal.median', 'brand', 'condition', 'locationText', 'title', 'url'] : ['deal.score', 'price', 'currency', 'deal.median', 'brand', 'condition', 'title', 'url'];
        if (command === 'deals' && limit) items = items.slice(0, limit);
      }
      if (pagination) logger.info(`${found.length} listings fetched (site reports ${pagination.totalEntries} across ${pagination.totalPages} pages)`);
      if (near && columns.includes('location')) columns[columns.indexOf('location')] = 'locationText';
      if (v.db) store.setScores(items.filter((i) => i.deal));
      if (v.ai) {
        items = await evaluateListings(items, { scraper, store, vision: vision(), rules, max: aiMax, luxuryOnly: !v['all-brands'], triage: v.triage, concurrency });
        items = items.filter((i) => i.buy).sort((a, b) => b.buy.score - a.buy.score);
        if (minBuy !== undefined) items = items.filter((i) => i.buy.score >= minBuy);
        if (v.db) store.setBuyScores(items);
        columns = ['buy.score', 'price', 'currency', 'buy.margin', 'buy.resaleEstimate', 'verdict.authenticity_risk', 'verdict.condition_grade', 'brand', 'size', 'title', 'url'];
        if (limit) items = items.slice(0, limit);
      }
      store.close();
      output(items, v, columns);
      break;
    }
    case 'item': {
      if (!rest[0]) fail('item needs an id or url');
      const detail = await scraper.item(rest[0]);
      if (v.seller && detail.seller?.id) detail.sellerProfile = await scraper.user(detail.seller.id);
      writeOutput([detail].flat(), { format: v.format && v.format !== 'table' ? v.format : 'json', out: v.out });
      break;
    }
    case 'hunt': {
      const store = openStore(v.db);
      scraper.store = store; scraper.geocoder.store = store;
      const tierSel = v.tier ?? '1';
      const brands = v.brand?.length ? v.brand : [...new Set(tierSel === '2' ? rules.brands.tier2 : tierSel === '3' ? rules.brands.tier3 ?? [] : tierSel === 'all' ? [...rules.brands.tier1, ...rules.brands.tier2, ...(rules.brands.tier3 ?? [])] : rules.brands.tier1)].filter((x) => !/ x$/.test(x));
      const minUpside = numOpt(v['min-upside'], 'min-upside') ?? 0.5;
      if (v['analyze-picks']) {
        // Second pass: photo-check stored triage picks that have no verdict yet.
        let picks = store.pendingPotential(minUpside, aiMax);
        logger.info(`${picks.length} stored picks with upside ≥ ${Math.round(minUpside * 100)}% await photo checks`);
        picks = await evaluateListings(picks, { scraper, store, vision: vision(), rules, max: aiMax, luxuryOnly: !v['all-brands'], triage: false, concurrency });
        picks = picks.filter((i) => i.buy).sort((a, b) => b.buy.score - a.buy.score);
        if (minBuy !== undefined) picks = picks.filter((i) => i.buy.score >= minBuy);
        store.close();
        output(picks, v, ['buy.score', 'price', 'currency', 'buy.margin', 'buy.resaleEstimate', 'verdict.authenticity_risk', 'verdict.condition_grade', 'brand', 'size', 'title', 'url']);
        break;
      }
      const near = await nearFor(v.near);
      const query = rest.join(' ') || undefined;
      logger.info(`hunt: ${brands.length} brands × ${pages} page(s)${query ? ` for "${query}"` : ''}`);
      const all = new Map();
      if (v['from-db']) {
        for (const it of store.list({ searchKey: v.name ?? `hunt:${tierSel}`, limit: 50000 })) all.set(it.id, it);
        logger.info(`loaded ${all.size} listings from the database (skipping Vinted search)`);
      }
      for (const brand of v['from-db'] ? [] : brands) {
        try {
          const { items } = await scraper.search({ query, brand, category: v.category, condition: v.condition, order: v.order ?? 'newest', priceFrom: numOpt(v.min, 'min') ?? priceFloor(brandTierOf(brand), rules), priceTo: numOpt(v.max, 'max'), include: v.include, exclude: v.exclude }, { pages, near });
          for (const it of items) all.set(it.id, { ...it, huntBrand: brand });
          logger.info(`  ${brand}: ${items.length} listings`);
        } catch (e) { logger.warn(`  ${brand}: ${e.message}`); }
      }
      let items = [...all.values()];
      const { newItems } = store.recordSeen(v.name ?? `hunt:${tierSel}`, items);
      logger.info(`${items.length} listings across ${brands.length} brands (${newItems.length} new); triage + photo checks on the best ${aiMax}`);
      items = await evaluateListings(items, { scraper, store, vision: vision(), rules, max: aiMax, minUpside, luxuryOnly: !v['all-brands'], triage: !v['no-triage'], concurrency });
      items = items.filter((i) => i.buy).sort((a, b) => b.buy.score - a.buy.score);
      store.setBuyScores(items);
      if (minBuy !== undefined) items = items.filter((i) => i.buy.score >= minBuy);
      if (limit) items = items.slice(0, limit);
      store.close();
      output(items, v, ['buy.score', 'price', 'currency', 'buy.margin', 'buy.resaleEstimate', 'verdict.authenticity_risk', 'verdict.condition_grade', 'brand', 'size', 'title', 'url']);
      break;
    }
    case 'recheck': {
      // Paper trading: if a listing we rated a strong buy disappears fast at that price, other buyers agreed. That is the
      // closest thing Vinted offers to a "sold at" signal, and it validates the resale estimates over time.
      const store = openStore(v.db);
      const threshold = minBuy ?? 50;
      const targets = store.toRecheck(threshold, limit ?? 200);
      logger.info(`rechecking ${targets.length} listings with buy ≥ ${threshold}`);
      const rows = [];
      for (const it of targets) {
        let status;
        try {
          const d = await scraper.item(it.id);
          status = d.flags.isReserved ? 'reserved' : d.flags.isHidden || !d.flags.canBuy ? 'sold' : 'available';
        } catch (e) {
          status = e.code === 'NOT_FOUND' ? 'removed' : 'error';
        }
        if (status !== 'error') store.setStatus(it.id, status);
        const hours = Math.round((Date.now() - new Date(it.firstSeen)) / 36e5);
        rows.push({ id: it.id, buy: it.buy?.score, price: it.price, margin: it.buy?.margin, status, hoursSinceSeen: hours, brand: it.brand, title: it.title, url: it.url });
        logger.info(`  ${status.padEnd(9)} buy ${String(it.buy?.score).padStart(3)}  ${it.price} ${it.currency}  ${it.brand}  ${(it.title || '').slice(0, 50)}`);
      }
      const summary = store.outcomes(threshold);
      store.close();
      logger.info('outcomes so far: ' + summary.map((o) => `${o.status ?? 'unchecked'}=${o.n}`).join(', '));
      output(rows, v, ['status', 'buy', 'price', 'margin', 'hoursSinceSeen', 'brand', 'title', 'url']);
      break;
    }
    case 'rescore': {
      const store = openStore(v.db);
      const rows = store.db.prepare('SELECT i.json AS item, v.json AS verdict FROM items i JOIN verdicts v ON v.item_id = i.id').all();
      const updated = [];
      for (const r of rows) {
        const it = JSON.parse(r.item);
        const verdict = normalizeVerdict(JSON.parse(r.verdict).verdict);
        if (!verdict) continue;
        it.verdict = verdict;
        it.buy = buyScore(it, { verdict, rules });
        updated.push(it);
      }
      store.setBuyScores(updated);
      store.close();
      logger.info(`rescored ${updated.length} listings with current rules`);
      output(updated.sort((a, b) => b.buy.score - a.buy.score).slice(0, limit ?? 25), v, ['buy.score', 'price', 'currency', 'buy.margin', 'buy.resaleEstimate', 'buy.itemType', 'brand', 'title', 'url']);
      break;
    }
    case 'analyze': {
      if (!rest[0]) fail('analyze needs an item id or url');
      const store = openStore(v.db);
      const detail = await scraper.item(rest[0]);
      const listing = { id: detail.id, title: detail.title, brand: detail.brand?.title, size: detail.size?.value, condition: detail.condition, conditionId: detail.conditionId, price: detail.price, currency: detail.currency, buyerPrice: detail.buyerPrice, photos: detail.photos, url: detail.url, detail };
      const res = await analyzeListing(listing, { client: vision(), store, force: v.force });
      const buy = buyScore(listing, { verdict: res.verdict, rules });
      if (store.q.get.get(listing.id)) store.setBuyScores([{ ...listing, verdict: res.verdict, buy }]);
      store.close();
      writeOutput([{ id: listing.id, title: listing.title, url: listing.url, price: listing.price, currency: listing.currency, buy, verdict: res.verdict, model: res.model, usage: res.usage, cost: res.cost, cached: res.cached }], { format: v.format && v.format !== 'table' ? v.format : 'json', out: v.out });
      break;
    }
    case 'user': {
      if (!rest[0]) fail('user needs a numeric id');
      writeOutput([await scraper.user(rest[0])], { format: v.format && v.format !== 'table' ? v.format : 'json', out: v.out });
      break;
    }
    case 'brands': {
      if (!rest[0]) fail('brands needs a keyword');
      output(await scraper.brands(rest.join(' ')), v, ['id', 'title', 'itemCount', 'favouriteCount']);
      break;
    }
    case 'catalogs': {
      const all = await scraper.catalogs();
      const q = rest.join(' ').toLowerCase();
      const rows = q ? all.filter((c) => c.path.toLowerCase().includes(q) || c.slug?.includes(q)) : all;
      output(rows, v, ['id', 'slug', 'path']);
      break;
    }
    case 'watch': {
      let config = {};
      if (v.config) {
        if (!existsSync(v.config)) fail(`config file ${v.config} not found (run "vinted init")`);
        config = JSON.parse(readFileSync(v.config, 'utf8'));
      }
      const searches = [...(config.searches ?? [])];
      const inline = rest.join(' ');
      if (inline || v.brand || v.category) searches.push({ name: v.name, ...searchParamsFromFlags(v, inline) });
      if (!searches.length) fail('watch needs --config with searches or an inline query');
      if (config.domain && !v.domain) scraper.client.baseUrl = `https://www.vinted.${config.domain}`;
      const store = new Store(v.db ?? config.db ?? 'vinted.db');
      scraper.store = store; scraper.geocoder.store = store;
      const nearInput = v.near ?? config.near;
      const near = nearInput ? await scraper.near(nearInput, { radiusKm: numOpt(v.radius, 'radius') ?? config.radiusKm ?? 50, strict: v['strict-location'] ?? config.strictLocation ?? false }) : undefined;
      if (near) logger.info(`location filter: within ${near.radiusKm} km of ${near.name} (${near.countryCode})${near.strict ? ', strict' : ''}`);
      const tg = config.telegram ?? {};
      const telegram = { token: v['telegram-token'] ?? tg.token ?? process.env.TELEGRAM_BOT_TOKEN, chatId: v['telegram-chat'] ?? tg.chatId ?? process.env.TELEGRAM_CHAT_ID };
      const telegramMinScore = numOpt(v['telegram-min-score'], 'telegram-min-score') ?? tg.minScore ?? 60;
      if (telegram.token && telegram.chatId) logger.info(`telegram alerts on for deals scoring ≥ ${telegramMinScore}`);
      const aiCfg = config.ai ?? {};
      const aiOn = v.ai ?? aiCfg.enabled ?? false;
      const ai = aiOn ? { vision: vision(aiCfg.model), rules, max: intOpt(v['ai-max'], 'ai-max') ?? aiCfg.maxPerRun ?? 30, luxuryOnly: !(v['all-brands'] ?? aiCfg.allBrands), minBuy: minBuy ?? aiCfg.minBuy ?? 50 } : undefined;
      if (ai) logger.info(`ai buying assistant on: ${ai.vision.model}, up to ${ai.max} listings per run, alerts at buy ≥ ${ai.minBuy}`);
      const notify = createNotifier({ webhook: v.webhook ?? config.webhook, mac: v.mac ?? config.mac, telegram, telegramMinScore: ai ? 0 : telegramMinScore, logger });
      const ac = new AbortController();
      process.on('SIGINT', () => { logger.info('stopping…'); ac.abort(); });
      logger.info(`watching ${searches.length} search(es) every ${v.interval ?? config.intervalSec ?? 120}s on ${scraper.client.baseUrl}`);
      await watch({
        scraper, store, searches, notify,
        intervalSec: intOpt(v.interval, 'interval', { min: 10 }) ?? config.intervalSec ?? 120,
        pages: intOpt(v.pages, 'pages', { max: 10 }) ?? config.pages ?? 1,
        minScore: numOpt(v['min-score'], 'min-score') ?? config.minScore ?? 0,
        once: v.once, notifyFirstRun: v['notify-first-run'] ?? config.notifyFirstRun, near, ai,
        recheck: config.recheck === false ? undefined : { everySec: config.recheck?.everySec ?? 3600, minBuy: config.recheck?.minBuy ?? (ai ? ai.minBuy : 50), limit: config.recheck?.limit ?? 60 },
        signal: ac.signal, logger,
      });
      store.close();
      break;
    }
    case 'init': {
      const file = rest[0] ?? 'vinted.config.json';
      if (existsSync(file)) fail(`${file} already exists`);
      writeFileSync(file, JSON.stringify({
        domain: 'at', intervalSec: 120, db: 'vinted.db', webhook: '', mac: true, minScore: 0, pages: 2,
        near: 'Wien', radiusKm: 50, strictLocation: false,
        telegram: { token: '', chatId: '', minScore: 60 },
        ai: { enabled: false, model: 'qwen/qwen3.8-flash', maxPerRun: 30, minBuy: 50, allBrands: false },
        rules: 'rules.json',
        searches: [
          { name: 'Nike Air Max under 40', query: 'nike air max', brand: 'Nike', priceTo: 40, condition: ['new', 'very good'], order: 'newest', include: ['air ?max'], exclude: ['majica|tee|shirt|jersey'] },
          { name: 'Levis 501 W32', query: 'levis 501 w32', category: 'jeans', priceTo: 25 },
        ],
      }, null, 2) + '\n');
      process.stdout.write(`wrote ${file}; edit it and run: vinted watch --config ${file}\n`);
      break;
    }
    case 'serve': {
      let config = {};
      if (v.config && existsSync(v.config)) config = JSON.parse(readFileSync(v.config, 'utf8'));
      const store = new Store(v.db ?? config.db ?? 'vinted.db');
      const port = intOpt(v.port, 'port', { max: 65535 }) ?? 3210;
      const host = v.host ?? process.env.DASHBOARD_HOST ?? '127.0.0.1';
      const password = v.password ?? process.env.DASHBOARD_PASSWORD;
      if (host !== '127.0.0.1' && host !== 'localhost' && !password) fail('binding the dashboard to a non-local address requires --password (or DASHBOARD_PASSWORD)');
      const server = createDashboard({ store, domain: v.domain ?? config.domain ?? process.env.VINTED_DOMAIN ?? 'hr', logger, password });
      server.listen(port, host, () => process.stderr.write(`dashboard: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}  (db: ${v.db ?? config.db ?? 'vinted.db'}${password ? ', password protected' : ''})\n`));
      await new Promise((resolve) => process.on('SIGINT', () => { server.close(); store.close(); resolve(); }));
      break;
    }
    case 'colors':
      output(Object.entries(COLORS).map(([id, name]) => ({ id: Number(id), name })), v, ['id', 'name']);
      break;
    default:
      fail(`unknown command ${command}\n\n${HELP}`);
  }
  logger.debug(`requests: ${scraper.client.stats.requests}, retries: ${scraper.client.stats.retries}`);
}

main().catch((err) => {
  process.stderr.write(`error${err.code ? ` [${err.code}]` : ''}: ${err.message}\n`);
  if (process.env.VINTED_LOG === 'debug') console.error(err);
  process.exit(err.code === 'BAD_INPUT' ? 2 : 1);
});
