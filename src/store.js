import { DatabaseSync } from 'node:sqlite';
import { comparableKey } from './deals.js';

/**
 * Local SQLite state for incremental scraping: which listings were already seen, when, and at
 * what price. Zero dependencies thanks to Node's built-in `node:sqlite`.
 */
export class Store {
  constructor(path = 'vinted.db') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY,
        search_key TEXT,
        title TEXT,
        brand TEXT,
        condition_id INTEGER,
        price REAL,
        currency TEXT,
        url TEXT,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        json TEXT
      );
      CREATE INDEX IF NOT EXISTS items_search_key ON items(search_key);
      CREATE TABLE IF NOT EXISTS price_history (
        item_id INTEGER NOT NULL,
        price REAL,
        seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS price_history_item ON price_history(item_id);
      CREATE TABLE IF NOT EXISTS sellers (id INTEGER PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS geocode (key TEXT PRIMARY KEY, lat REAL, lon REAL, name TEXT, country_code TEXT, fetched_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS verdicts (item_id INTEGER NOT NULL, model TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (item_id, model));
    `);
    for (const col of ['score REAL', 'location TEXT', 'search_name TEXT', 'buy_score REAL', 'buy TEXT', 'potential REAL', 'potential_json TEXT', 'status TEXT', 'status_checked_at TEXT', 'gone_at TEXT']) {
      try { this.db.exec(`ALTER TABLE items ADD COLUMN ${col}`); } catch { /* already there */ }
    }
    this.q = {
      get: this.db.prepare('SELECT price FROM items WHERE id = ?'),
      getJson: this.db.prepare('SELECT json FROM items WHERE id = ?'),
      insert: this.db.prepare('INSERT INTO items (id, search_key, title, brand, condition_id, price, currency, url, first_seen, last_seen, json) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
      update: this.db.prepare('UPDATE items SET price = ?, last_seen = ?, json = ?, title = ? WHERE id = ?'),
      history: this.db.prepare('INSERT INTO price_history (item_id, price, seen_at) VALUES (?,?,?)'),
      getHistory: this.db.prepare('SELECT price, seen_at FROM price_history WHERE item_id = ? ORDER BY seen_at, rowid'),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM items'),
      baseline: this.db.prepare('SELECT brand, condition_id, price FROM items WHERE price IS NOT NULL'),
      prune: this.db.prepare('DELETE FROM items WHERE last_seen < ?'),
      pruneHistory: this.db.prepare('DELETE FROM price_history WHERE item_id NOT IN (SELECT id FROM items)'),
      getSeller: this.db.prepare('SELECT json, fetched_at FROM sellers WHERE id = ?'),
      putSeller: this.db.prepare('INSERT OR REPLACE INTO sellers (id, json, fetched_at) VALUES (?,?,?)'),
      getGeo: this.db.prepare('SELECT lat, lon, name, country_code FROM geocode WHERE key = ?'),
      putGeo: this.db.prepare('INSERT OR REPLACE INTO geocode (key, lat, lon, name, country_code, fetched_at) VALUES (?,?,?,?,?,?)'),
      setScore: this.db.prepare('UPDATE items SET score = ?, json = ? WHERE id = ?'),
      searches: this.db.prepare('SELECT search_key AS key, COUNT(*) AS n, MAX(first_seen) AS latest FROM items GROUP BY search_key ORDER BY latest DESC'),
      getVerdict: this.db.prepare('SELECT json FROM verdicts WHERE item_id = ? AND model = ?'),
      putVerdict: this.db.prepare('INSERT OR REPLACE INTO verdicts (item_id, model, json, created_at) VALUES (?,?,?,?)'),
      setBuy: this.db.prepare('UPDATE items SET buy_score = ?, buy = ?, json = ? WHERE id = ?'),
      setPotential: this.db.prepare('UPDATE items SET potential = ?, potential_json = ?, json = ? WHERE id = ?'),
      pending: this.db.prepare('SELECT json FROM items WHERE potential >= ? AND buy_score IS NULL ORDER BY potential DESC LIMIT ?'),
      verdictCount: this.db.prepare('SELECT COUNT(*) AS n FROM verdicts'),
      setStatus: this.db.prepare("UPDATE items SET status = ?, status_checked_at = ?, gone_at = CASE WHEN ? IN ('sold','removed','reserved') AND gone_at IS NULL THEN ? ELSE gone_at END WHERE id = ?"),
      toRecheck: this.db.prepare("SELECT json, status, first_seen FROM items WHERE buy_score >= ? AND COALESCE(status,'available') NOT IN ('sold','removed') ORDER BY buy_score DESC LIMIT ?"),
      outcomes: this.db.prepare("SELECT status, COUNT(*) n, ROUND(AVG(price),2) avg_price, ROUND(AVG(buy_score)) avg_buy FROM items WHERE buy_score >= ? GROUP BY status"),
    };
  }

  /**
   * Records a batch of listings for a search and reports which are new and which dropped in price.
   * @returns {{ newItems: object[], priceDrops: object[] }}
   */
  recordSeen(searchKey, items, now = new Date().toISOString()) {
    const newItems = [];
    const priceDrops = [];
    const tx = () => {
      for (const it of items) {
        const row = this.q.get.get(it.id);
        const json = JSON.stringify(it);
        if (!row) {
          this.q.insert.run(it.id, searchKey, it.title ?? null, it.brand ?? null, it.conditionId ?? null, it.price ?? null, it.currency ?? null, it.url ?? null, now, now, json);
          this.q.history.run(it.id, it.price ?? null, now);
          newItems.push(it);
          continue;
        }
        const prev = this.q.getJson?.get(it.id);
        const merged = prev ? JSON.stringify({ ...JSON.parse(prev.json), ...it }) : json;
        this.q.update.run(it.price ?? null, now, merged, it.title ?? null, it.id);
        if (Number.isFinite(it.price) && Number.isFinite(row.price) && it.price !== row.price) {
          this.q.history.run(it.id, it.price, now);
          if (it.price < row.price) priceDrops.push({ ...it, previousPrice: row.price });
        }
      }
    };
    this.db.exec('BEGIN');
    try {
      tx();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { newItems, priceDrops };
  }

  priceHistory(itemId) {
    return this.q.getHistory.all(itemId).map((r) => ({ price: r.price, seenAt: r.seen_at }));
  }

  count() {
    return this.q.count.get().n;
  }

  /** Historical prices grouped by comparable key, for {@link scoreDeals}. */
  baseline() {
    const out = {};
    for (const r of this.q.baseline.all()) {
      const key = comparableKey({ brand: r.brand ?? undefined, conditionId: r.condition_id ?? undefined });
      (out[key] ??= []).push(r.price);
    }
    return out;
  }

  /** Listings for the dashboard/API. Sort: newest | score | price. */
  list({ searchKey, minScore, minBuy, minPotential, analyzed, maxPrice, locationStatus, sort = 'newest', limit = 200, offset = 0 } = {}) {
    const where = [];
    const args = [];
    if (searchKey) { where.push('search_key = ?'); args.push(searchKey); }
    if (minScore !== undefined) { where.push('COALESCE(score, 0) >= ?'); args.push(minScore); }
    if (maxPrice !== undefined) { where.push('price <= ?'); args.push(maxPrice); }
    if (locationStatus) { where.push("json_extract(json, '$.location.status') = ?"); args.push(locationStatus); }
    if (minBuy !== undefined) { where.push('COALESCE(buy_score, 0) >= ?'); args.push(minBuy); }
    if (analyzed) where.push('buy_score IS NOT NULL');
    if (minPotential !== undefined) { where.push('COALESCE(potential, -1) >= ?'); args.push(minPotential); }
    const order = { newest: 'first_seen DESC', score: 'COALESCE(score, 0) DESC, price ASC', buy: 'COALESCE(buy_score, -1) DESC, first_seen DESC', potential: 'COALESCE(potential, -9) DESC, price ASC', price: 'price ASC', updated: 'last_seen DESC' }[sort] ?? 'first_seen DESC';
    const sql = `SELECT json, score, buy_score, potential, first_seen, last_seen, search_key FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...args, limit, offset).map((r) => ({ ...JSON.parse(r.json), score: r.score ?? undefined, buyScore: r.buy_score ?? undefined, potential: r.potential ?? undefined, firstSeen: r.first_seen, lastSeen: r.last_seen, searchKey: r.search_key }));
  }

  searches() {
    return this.q.searches.all();
  }

  /** Persists deal scores (and the enriched item json) after scoring. */
  setScores(items) {
    this.db.exec('BEGIN');
    try {
      for (const it of items) this.q.setScore.run(it.deal?.score ?? it.score ?? null, JSON.stringify(it), it.id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** Persists triage results: `potential` = (est resale - price) / price. */
  setTriage(items) {
    this.db.exec('BEGIN');
    try {
      for (const it of items) {
        if (!it.triage) continue;
        const upside = it.triage.worth_checking && it.triage.est_resale_eur && it.price ? (it.triage.est_resale_eur - it.price) / it.price : -1;
        this.q.setPotential.run(Number(upside.toFixed(3)), JSON.stringify(it.triage), JSON.stringify(it), it.id);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** Triage picks above an upside threshold that have no verdict yet. */
  pendingPotential(minUpside = 0.5, limit = 1000) {
    return this.q.pending.all(minUpside, limit).map((r) => JSON.parse(r.json));
  }

  setStatus(id, status, now = new Date().toISOString()) {
    this.q.setStatus.run(status, now, status, now, id);
  }

  toRecheck(minBuy = 50, limit = 200) {
    return this.q.toRecheck.all(minBuy, limit).map((r) => ({ ...JSON.parse(r.json), status: r.status ?? 'available', firstSeen: r.first_seen }));
  }

  outcomes(minBuy = 50) {
    return this.q.outcomes.all(minBuy);
  }

  getVerdict(itemId, model) {
    const r = this.q.getVerdict.get(itemId, model);
    return r ? JSON.parse(r.json) : undefined;
  }

  putVerdict(itemId, model, result) {
    this.q.putVerdict.run(itemId, model, JSON.stringify(result), new Date().toISOString());
  }

  verdictCount() {
    return this.q.verdictCount.get().n;
  }

  /** Persists buy scores (items must carry a `buy` object; verdict/detail are kept in json). */
  setBuyScores(items) {
    this.db.exec('BEGIN');
    try {
      for (const it of items) if (it.buy) this.q.setBuy.run(it.buy.score, JSON.stringify(it.buy), JSON.stringify(it), it.id);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  getSeller(id, { maxAgeMs = 30 * 864e5 } = {}) {
    const r = this.q.getSeller.get(id);
    if (!r || Date.now() - r.fetched_at > maxAgeMs) return undefined;
    return JSON.parse(r.json);
  }

  putSeller(profile) {
    this.q.putSeller.run(profile.id, JSON.stringify(profile), Date.now());
  }

  /** Returns the cached point, `null` for a cached miss, or `undefined` when unknown. */
  getGeocode(key) {
    const r = this.q.getGeo.get(key);
    if (!r) return undefined;
    if (r.lat === null) return null;
    return { lat: r.lat, lon: r.lon, name: r.name, countryCode: r.country_code };
  }

  putGeocode(key, point) {
    this.q.putGeo.run(key, point?.lat ?? null, point?.lon ?? null, point?.name ?? null, point?.countryCode ?? null, Date.now());
  }

  pruneOlderThan(days) {
    const cutoff = new Date(Date.now() - days * 864e5).toISOString();
    const n = this.q.prune.run(cutoff).changes;
    this.q.pruneHistory.run();
    return n;
  }

  close() {
    this.db.close();
  }
}
