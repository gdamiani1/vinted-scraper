import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatLocation } from './geo.js';
import { loadRules, fitsMySize } from './rules.js';
import { existsSync } from 'node:fs';

const UI_PATH = fileURLToPath(new URL('./ui.html', import.meta.url));

/**
 * Tiny local dashboard over the SQLite store. No framework, no build step.
 * GET /                 → single-page UI
 * GET /api/items        → ?search=&minScore=&maxPrice=&location=within|unknown&sort=newest|score|price&limit=&offset=
 * GET /api/searches     → saved searches with counts
 * GET /api/stats        → totals
 */
export function createDashboard({ store, domain, logger, rules }) {
  rules ??= loadRules(existsSync('rules.json') ? 'rules.json' : undefined);
  const ui = () => readFileSync(UI_PATH, 'utf8'); // re-read each request so edits show up without restart
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(ui());
      }
      if (url.pathname === '/api/items') {
        const q = url.searchParams;
        const num = (k) => (q.get(k) === null || q.get(k) === '' ? undefined : Number(q.get(k)));
        const mySize = q.get('mySize') === '1';
        let items = store.list({
          searchKey: q.get('search') || undefined,
          minScore: num('minScore'),
          minBuy: num('minBuy'),
          minPotential: num('minPotential'),
          analyzed: q.get('analyzed') === '1',
          maxPrice: num('maxPrice'),
          locationStatus: q.get('location') || undefined,
          sort: q.get('sort') || 'newest',
          limit: mySize ? 5000 : Math.min(num('limit') ?? 120, 500),
          offset: num('offset') ?? 0,
        });
        if (mySize) items = items.filter((it) => fitsMySize(it, rules)).slice(0, Math.min(num('limit') ?? 120, 500));
        items = items.map((it) => ({ ...it, locationText: formatLocation(it.location), messageUrl: it.sellerId ? `https://www.vinted.${domain}/member/${it.sellerId}` : undefined }));
        return json(res, 200, { items });
      }
      if (url.pathname === '/api/searches') return json(res, 200, { searches: store.searches() });
      if (url.pathname === '/api/stats') return json(res, 200, { items: store.count(), verdicts: store.verdictCount(), domain });
      json(res, 404, { error: 'not found' });
    } catch (err) {
      logger?.error(err.message);
      json(res, 500, { error: err.message });
    }
  });
}
