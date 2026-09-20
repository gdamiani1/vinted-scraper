import { analyzeListing } from './vision.js';
import { buyScore, brandTier, priceFloor } from './rules.js';
import { normalizeText } from './util.js';

/** Cheap pre-filter: luxury brand, not packaging/samples, not below the luxury price floor. */
export function isCandidate(item, rules, { luxuryOnly = true } = {}) {
  const tier = brandTier(item.brand, rules);
  if (luxuryOnly && tier === 'other') return false;
  const hay = normalizeText(`${item.title ?? ''} ${item.detail?.description ?? ''}`);
  if ((rules.packagingWords ?? []).some((w) => hay.includes(normalizeText(w)))) return false;
  if (tier !== 'other' && Number.isFinite(item.price) && item.price < priceFloor(tier, rules)) return false;
  return true;
}

/**
 * The "eyes + judgement" pass.
 * 1. cheap filters (brand tier, packaging words, price floor)
 * 2. optional text-only triage: one model call per ~40 listings picks what is worth a photo check
 * 3. item details fetched (throttled, sequential), then vision verdicts with bounded concurrency
 * 4. resale buy score
 *
 * @returns all items; evaluated ones carry `detail`, `verdict`, `buy` (and `triage` when used).
 */
export async function evaluateListings(items, { scraper, store, vision, rules, max = 30, minUpside, luxuryOnly = true, triage = false, concurrency = 4, comparablesFor, prefilter, logger = scraper.logger } = {}) {
  const eligible = items.filter((it) => isCandidate(it, rules, { luxuryOnly }));
  logger.info(`[ai] ${eligible.length} of ${items.length} listings pass the cheap filters`);
  const out = new Map(items.map((it) => [it.id, it]));
  let ranked;
  if (triage && eligible.length) {
    const picks = await vision.triage(eligible);
    const triaged = eligible.map((it) => ({ ...it, triage: picks.get(it.id) })).filter((it) => it.triage);
    store?.setTriage?.(triaged);
    const upside = (it) => (it.triage.est_resale_eur && it.price ? (it.triage.est_resale_eur - it.price) / it.price : 0);
    const chosen = triaged.filter((it) => it.triage.worth_checking && (minUpside === undefined || upside(it) >= minUpside));
    ranked = chosen.sort((a, b) => upside(b) - upside(a)).slice(0, max);
    for (const it of ranked) out.set(it.id, it);
    logger.info(`[ai] triage picked ${triaged.filter((t) => t.triage.worth_checking).length} of ${triaged.length}${minUpside !== undefined ? `, ${chosen.length} with upside ≥ ${Math.round(minUpside * 100)}%` : ''}; photo-checking ${ranked.length}`);
  } else {
    ranked = [...eligible].sort((a, b) => (b.deal?.score ?? 0) - (a.deal?.score ?? 0) || (a.price ?? 0) - (b.price ?? 0)).slice(0, max);
  }
  if (prefilter) { const before = ranked.length; ranked = await prefilter(ranked); logger.info(`[ai] ${ranked.length} of ${before} candidates pass the seller filter`); }
  // Pipeline: one producer fetches item details from Vinted (sequential, throttled) and hands each
  // listing to the vision workers as soon as it is ready, so photo checks start immediately.
  const withDetail = [];
  let producerDone = false;
  const producer = (async () => {
    for (const it of ranked) {
      const copy = { ...it };
      if (!copy.detail) {
        try { copy.detail = await scraper.item(copy.id); } catch (e) { copy.buyError = e.message; logger.warn(`[ai] ${copy.id}: ${e.message}`); }
      }
      withDetail.push(copy);
    }
    producerDone = true;
  })();
  let spent = 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (next >= withDetail.length) {
        if (producerDone) break;
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      const copy = withDetail[next++];
      if (copy.buyError) { out.set(copy.id, copy); continue; }
      try {
        const res = await analyzeListing(copy, { client: vision, store });
        copy.verdict = res.verdict;
        copy.verdictModel = res.model;
        if (res.cost) spent += res.cost;
        copy.buy = buyScore(copy, { verdict: res.verdict, rules, comparables: comparablesFor?.(copy) ?? [] });
        store?.setBuyScores?.([copy]);
        logger.info(`[ai] ${copy.id} ${copy.brand ?? ''} ${copy.price} ${copy.currency ?? ''} → buy ${copy.buy.score}${res.cached ? ' (cached)' : ''}: ${res.verdict.summary ?? ''}`);
      } catch (e) {
        copy.buyError = e.message;
        logger.warn(`[ai] ${copy.id}: ${e.message}`);
        if (e.code === 'NO_API_KEY') throw e;
      }
      out.set(copy.id, copy);
    }
  };
  await Promise.all([producer, ...Array.from({ length: Math.max(1, Math.min(concurrency, ranked.length)) }, worker)]);
  if (spent) logger.info(`[ai] estimated spend ${spent.toFixed(4)} USD for ${withDetail.length} photo checks`);
  return [...out.values()];
}

/** Rules-only buy score for listings without a verdict (fast, free, used as the pre-filter). */
export function prescore(items, { rules, comparablesFor }) {
  return items.map((it) => ({ ...it, buy: it.buy ?? buyScore(it, { rules, comparables: comparablesFor?.(it) ?? [] }) }));
}
