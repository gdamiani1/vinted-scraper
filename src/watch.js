import { sleep, jitter } from './util.js';
import { scoreDeals } from './deals.js';
import { evaluateListings } from './buyer.js';
import { embedNewItems, broadRecheck } from './enrich.js';

/** Stable key so the same saved search maps to the same rows in the store across restarts. */
export function searchKey(search) {
  if (search.name) return search.name;
  const { query, brand, brandIds, category, catalogIds, condition, statusIds, priceFrom, priceTo, sizeIds, colorIds, color, include, exclude } = search;
  return JSON.stringify({ query, brand, brandIds, category, catalogIds, condition, statusIds, priceFrom, priceTo, sizeIds, colorIds, color, include, exclude });
}

/**
 * Polls saved searches forever (or once), records results in the store, and notifies about new
 * listings and price drops. The first pass only seeds the store unless `notifyFirstRun` is set.
 *
 * @param {object} opts
 * @param {import('./scraper.js').VintedScraper} opts.scraper
 * @param {import('./store.js').Store} opts.store
 * @param {object[]} opts.searches saved searches (FriendlyParams + optional name/pages/minScore)
 * @param {(event: object) => Promise<void>} opts.notify
 */
export async function watch({ scraper, store, searches, notify, intervalSec = 120, pages = 1, minScore = 0, once = false, notifyFirstRun = false, near, ai, recheck = { everySec: 3600, minBuy: 50, limit: 60 }, embedder, rules, broadRecheckAt = '02:30', signal, logger = scraper.logger }) {
  let lastBroadDay = '';
  const state = new Map(searches.map((s) => [searchKey(s), { firstRun: true, failures: 0, disabled: false }]));
  let round = 0;
  let lastRecheck = Date.now(); // first recheck one interval in, so seeding is not delayed
  while (!signal?.aborted) {
    round++;
    for (const search of searches) {
      if (signal?.aborted) break;
      const key = searchKey(search);
      const st = state.get(key);
      if (st.disabled) continue;
      try {
        const { near: _n, radiusKm: _r, strictLocation: _s, pages: _p, minScore: _m, name: _name, ...params } = search;
        const searchNear = search.near === false ? undefined : search.near ? await scraper.near(search.near, { radiusKm: search.radiusKm ?? near?.radiusKm ?? 50, strict: search.strictLocation ?? near?.strict ?? false }) : near;
        const { items } = await scraper.search({ order: 'newest', ...params }, { pages: search.pages ?? pages, near: searchNear });
        const { newItems, priceDrops } = store.recordSeen(key, items);
        store.setScores(scoreDeals(items, { baseline: store.baseline() }));
        logger.info(`[${key}] ${items.length} listings, ${newItems.length} new, ${priceDrops.length} price drops${st.firstRun ? ' (seeding)' : ''}`);
        st.failures = 0;
        if (st.firstRun && !notifyFirstRun) {
          st.firstRun = false;
          continue;
        }
        st.firstRun = false;
        const threshold = search.minScore ?? minScore;
        const baseline = store.baseline();
        const decorate = (list) => {
          const scored = scoreDeals(list.map((n) => items.find((i) => i.id === n.id) ?? n), { baseline });
          return scored
            .map((s) => ({ ...s, previousPrice: list.find((n) => n.id === s.id)?.previousPrice }))
            .filter((s) => s.deal.score >= threshold)
            .sort((a, b) => b.deal.score - a.deal.score);
        };
        let fresh = decorate(newItems);
        let drops = decorate(priceDrops);
        if (ai) {
          // Eyes on the new arrivals only; alerts are gated by buy score instead of deal score.
          fresh = await evaluateListings(fresh, { scraper, store, vision: ai.vision, rules: ai.rules, max: ai.max, luxuryOnly: ai.luxuryOnly, triage: fresh.length > 8, concurrency: 4, logger });
          store.setBuyScores(fresh.filter((i) => i.buy));
          fresh = fresh.filter((i) => i.buy && i.buy.score >= ai.minBuy).sort((a, b) => b.buy.score - a.buy.score);
          drops = drops.filter((i) => store.list({ limit: 1, minBuy: ai.minBuy }).some((x) => x.id === i.id) || !i.buy);
        }
        if (fresh.length) await notify({ type: ai ? 'buy' : 'new', search: key, items: fresh });
        if (drops.length) await notify({ type: 'price_drop', search: key, items: drops });
      } catch (err) {
        if (err.code === 'BAD_INPUT') {
          st.disabled = true;
          logger.error(`[${key}] ${err.message} — search disabled; fix the config and restart`);
          continue;
        }
        st.failures++;
        logger.error(`[${key}] ${err.message}`);
        if (st.failures >= 3) {
          const pause = Math.min(30 * 60, intervalSec * 2 ** (st.failures - 2));
          logger.warn(`[${key}] ${st.failures} consecutive failures; pausing ${pause}s`);
          await sleep(pause * 1000);
        }
      }
    }
    // Local embeddings + labels for whatever arrived this round (a few hundred ms per listing).
    if (embedder) {
      try { const n = await embedNewItems({ store, embedder, limit: 300, concurrency: 3, logger }); if (n) logger.info(`[embed] labelled ${n} new listings`); }
      catch (e) { logger.warn(`[embed] ${e.message}`); }
    }
    // Nightly broad status check for sell-through statistics.
    if (broadRecheckAt && rules) {
      const now = new Date();
      const [hh, mm] = String(broadRecheckAt).split(':').map(Number);
      const today = now.toDateString();
      if (lastBroadDay !== today && (now.getHours() > hh || (now.getHours() === hh && now.getMinutes() >= mm))) {
        lastBroadDay = today;
        try { const r = await broadRecheck({ scraper, store, rules, limit: 1000, logger, signal }); logger.info(`[recheck:broad] ${r.checked} listings checked, ${r.gone} newly gone`); }
        catch (e) { logger.warn(`[recheck:broad] ${e.message}`); }
      }
    }
    // Paper-trading loop: revisit strong buys and record whether they sold, got reserved or vanished.
    if (recheck && Date.now() - lastRecheck >= recheck.everySec * 1000 && !signal?.aborted) {
      lastRecheck = Date.now();
      try {
        const targets = store.toRecheck(recheck.minBuy, recheck.limit);
        const gone = [];
        for (const it of targets) {
          if (signal?.aborted) break;
          let status;
          try {
            const d = await scraper.item(it.id);
            status = d.flags.isReserved ? 'reserved' : d.flags.isHidden || !d.flags.canBuy ? 'sold' : 'available';
          } catch (e) { status = e.code === 'NOT_FOUND' ? 'removed' : undefined; }
          if (status) { store.setStatus(it.id, status); if (status !== 'available' && it.status !== status) gone.push({ ...it, status }); }
        }
        const summary = store.outcomes(recheck.minBuy).map((o) => `${o.status ?? 'unchecked'}=${o.n}`).join(', ');
        logger.info(`[recheck] ${targets.length} strong buys revisited; ${gone.length} newly gone; totals: ${summary}`);
      } catch (e) { logger.warn(`[recheck] ${e.message}`); }
    }
    if (once) return round;
    const wait = jitter(intervalSec * 1000, 0.2);
    logger.debug(`sleeping ${(wait / 1000).toFixed(0)}s`);
    await Promise.race([sleep(wait), new Promise((r) => signal?.addEventListener('abort', r, { once: true }))]);
  }
  return round;
}
