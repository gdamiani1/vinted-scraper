/**
 * Explainable deal scoring. Each listing is compared with a set of comparables (same brand and
 * condition when enough of them exist, otherwise the whole result set) and optionally with
 * historical prices from the local store. The score is 0-100 and every contributing factor is
 * listed in `reasons` so a human can sanity-check the recommendation.
 */

export function median(values) {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return undefined;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const NEW_WORDS = /\b(novo|nova|novi|new|nwt|bnwt|neu|neuf|neuve|nuovo|nuova|nuevo|nueva|nowy|nowe|nowa|nieuw|novinka|nové|nauja|új|nou)\b/i;
const TAG_WORDS = /etiket|\btags?\b|cartellin|metk|prijskaartje|visačk|címk|birk|sildi/i;

export function comparableKey(item) {
  return `${item.brand ?? '?'}|${item.conditionId ?? '?'}`;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * @param {object[]} items normalised listings
 * @param {object} [opts]
 * @param {Record<string, number[]>} [opts.baseline] historical prices per comparable key (see Store#baseline)
 * @param {number} [opts.minGroup] minimum comparables before a brand+condition group is trusted
 * @param {boolean} [opts.sort] sort result by score, best first
 */
export function scoreDeals(items, { baseline = {}, minGroup = 5, sort = false } = {}) {
  const groups = new Map();
  for (const it of items) {
    const key = comparableKey(it);
    if (!groups.has(key)) groups.set(key, []);
    if (Number.isFinite(it.price)) groups.get(key).push(it);
  }
  const allPrices = items.map((i) => i.price).filter(Number.isFinite);
  const allBaseline = Object.values(baseline).flat();

  const scored = items.map((item) => {
    const key = comparableKey(item);
    const reasons = [];
    let comparables = [
      ...(groups.get(key) ?? []).filter((o) => o.id !== item.id).map((o) => o.price),
      ...(baseline[key] ?? []),
    ];
    let usedKey = key;
    if (comparables.length < minGroup) {
      comparables = [...allPrices.filter((_, i) => items[i].id !== item.id), ...allBaseline];
      usedKey = '*';
    }
    const med = comparables.length >= 2 ? median(comparables) : undefined;
    let belowMedianPct;
    let score = 0;
    if (med && Number.isFinite(item.price) && med > 0) {
      belowMedianPct = (med - item.price) / med;
      score += clamp(belowMedianPct, -1, 1) * 70;
      if (belowMedianPct >= 0.15) reasons.push(`${Math.round(belowMedianPct * 100)}% below median of ${comparables.length} comparables (${med.toFixed(2)})`);
      else if (belowMedianPct <= -0.15) reasons.push(`${Math.round(-belowMedianPct * 100)}% above median (${med.toFixed(2)})`);
    }
    if (item.conditionId === 6) {
      score += 15;
      reasons.push('New with tags (condition)');
    } else if (item.conditionId === 1) {
      score += 8;
      reasons.push('New without tags (condition)');
    } else if (NEW_WORDS.test(item.title ?? '') && TAG_WORDS.test(item.title ?? '')) {
      score += 10;
      reasons.push('Title mentions new with tags');
    } else if (NEW_WORDS.test(item.title ?? '')) {
      score += 5;
      reasons.push('Title mentions new');
    }
    if (item.favouriteCount >= 5) {
      score += Math.min(5, item.favouriteCount / 5);
      reasons.push(`${item.favouriteCount} favourites (demand signal)`);
    }
    if (item.isPromoted) {
      score -= 3;
      reasons.push('Promoted listing');
    }
    return {
      ...item,
      deal: {
        score: Math.round(clamp(score, 0, 100)),
        belowMedianPct: belowMedianPct === undefined ? undefined : Number(belowMedianPct.toFixed(3)),
        median: med === undefined ? undefined : Math.round(med * 100) / 100,
        comparableCount: comparables.length,
        comparableKey: usedKey,
        reasons,
      },
    };
  });
  if (sort) scored.sort((a, b) => b.deal.score - a.deal.score || a.price - b.price);
  return scored;
}
