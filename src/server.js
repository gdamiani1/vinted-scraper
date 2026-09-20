import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatLocation } from './geo.js';
import { loadRules, fitsMySize } from './rules.js';
import { Embedder, rankBySimilarity } from './embed.js';
import { sellThrough } from './stats.js';
import { TAXONOMY } from './embed.js';
import { COLOR_NAMES } from './color.js';
import { existsSync } from 'node:fs';

const UI_PATH = fileURLToPath(new URL('./ui.html', import.meta.url));

/**
 * Tiny local dashboard over the SQLite store. No framework, no build step.
 * GET /                 → single-page UI
 * GET /api/items        → ?search=&minScore=&maxPrice=&location=within|unknown&sort=newest|score|price&limit=&offset=
 * GET /api/searches     → saved searches with counts
 * GET /api/stats        → totals
 */
export function createDashboard({ store, domain, logger, rules, password = process.env.DASHBOARD_PASSWORD, embedder }) {
  rules ??= loadRules(existsSync('rules.json') ? 'rules.json' : undefined);
  embedder ??= new Embedder({ logger });
  let vecCache = { n: -1, rows: [] };
  const vectors = () => { const n = store.embeddingCount(); if (n !== vecCache.n) vecCache = { n, rows: store.allEmbeddings() }; return vecCache.rows; };
  const listOpts = (q) => {
    const num = (k) => (q.get(k) === null || q.get(k) === '' ? undefined : Number(q.get(k)));
    return { searchKey: q.get('search') || undefined, minScore: num('minScore'), minBuy: num('minBuy'), minPotential: num('minPotential'), analyzed: q.get('analyzed') === '1', maxPrice: num('maxPrice'), locationStatus: q.get('location') || undefined, category: q.get('category') || undefined, style: q.get('style') || undefined, color: q.get('color') || undefined, material: q.get('material') || undefined, gender: q.get('gender') || undefined, sort: q.get('sort') || 'newest', limit: Math.min(num('limit') ?? 120, 500), offset: num('offset') ?? 0 };
  };
  const decorate = (items) => items.map((it) => ({ ...it, locationText: formatLocation(it.location), messageUrl: it.sellerId ? `https://www.vinted.${domain}/member/${it.sellerId}` : undefined }));
  const ui = () => readFileSync(UI_PATH, 'utf8'); // re-read each request so edits show up without restart
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (password) {
      const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
      const ok = scheme === 'Basic' && Buffer.from(encoded ?? '', 'base64').toString().split(':').slice(1).join(':') === password;
      if (!ok) { res.writeHead(401, { 'www-authenticate': 'Basic realm="Vinted Watch"', 'content-type': 'text/plain' }); return res.end('password required'); }
    }
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(ui());
      }
      if (url.pathname === '/api/items') {
        const q = url.searchParams;
        const opts = listOpts(q);
        const mySize = q.get('mySize') === '1';
        const text = (q.get('q') || '').trim();
        const wantLimit = opts.limit;
        if (text || mySize) opts.limit = 5000;
        let items;
        if (text) {
          // Semantic search: rank every embedded listing by CLIP similarity to the query, then apply the other filters.
          return embedder.embedText(text).then((qv) => {
            const ranked = rankBySimilarity(qv, vectors(), { limit: 400 });
            const order = new Map(ranked.map((r, i) => [r.id, i]));
            let rows = store.list({ ...opts, ids: ranked.map((r) => r.id), sort: 'newest', limit: 5000 });
            if (mySize) rows = rows.filter((it) => fitsMySize(it, rules));
            rows.sort((a, b) => order.get(a.id) - order.get(b.id));
            json(res, 200, { items: decorate(rows.slice(0, wantLimit)), query: text });
          }).catch((e) => json(res, 500, { error: e.message }));
        }
        items = store.list(opts);
        if (mySize) items = items.filter((it) => fitsMySize(it, rules)).slice(0, wantLimit);
        return json(res, 200, { items: decorate(items) });
      }
      if (url.pathname === '/api/similar') {
        const id = Number(url.searchParams.get('id'));
        const rows = vectors();
        const me = rows.find((r) => r.id === id);
        if (!me) return json(res, 404, { error: 'no embedding for this listing yet' });
        const ranked = rankBySimilarity(me.vec, rows, { limit: 60, exclude: id });
        const order = new Map(ranked.map((r, i) => [r.id, i]));
        const items = store.list({ ids: ranked.map((r) => r.id), limit: 100 }).sort((a, b) => order.get(a.id) - order.get(b.id));
        return json(res, 200, { items: decorate(items).map((it) => ({ ...it, similarity: ranked.find((r) => r.id === it.id)?.score })) });
      }
      if (url.pathname === '/api/taxonomy') return json(res, 200, { ...store.taxonomyCounts(), embedded: store.embeddingCount(), options: { category: Object.keys(TAXONOMY.category), style: Object.keys(TAXONOMY.style).filter((x) => x !== 'contemporary'), color: COLOR_NAMES, material: Object.keys(TAXONOMY.material), gender: Object.keys(TAXONOMY.gender) } });
      if (url.pathname === '/api/tag' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
        return req.on('end', () => {
          try {
            const { id, tags } = JSON.parse(body);
            for (const [field, value] of Object.entries(tags ?? {})) store.setHumanLabel(Number(id), field, value === '' ? null : value);
            json(res, 200, { ok: true, human: store.humanLabels(Number(id)) });
          } catch (e) { json(res, 400, { error: e.message }); }
        });
      }
      if (url.pathname === '/api/tags') {
        const { counts, pairs } = store.humanStats();
        const agreement = {};
        for (const p of pairs) { const a = (agreement[p.field] ??= { n: 0, agree: 0 }); if (p.auto !== null && p.auto !== undefined) { a.n++; if (p.auto === p.human) a.agree++; } }
        return json(res, 200, { counts, agreement });
      }
      if (url.pathname === '/api/sellthrough') return json(res, 200, sellThrough(store.sellThroughRows(Number(url.searchParams.get('days') || 30)), { rules }));
      if (url.pathname === '/api/searches') return json(res, 200, { searches: store.searches() });
      if (url.pathname === '/api/stats') return json(res, 200, { items: store.count(), verdicts: store.verdictCount(), domain });
      json(res, 404, { error: 'not found' });
    } catch (err) {
      logger?.error(err.message);
      json(res, 500, { error: err.message });
    }
  });
}
