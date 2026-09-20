import { brandTier } from './rules.js';
import { median } from './deals.js';

const HOURS = 3600e3;

/**
 * Sell-through statistics from recheck outcomes. A listing counts as "gone" when its status is
 * sold or removed (reserved counts as pending). Survival is measured only over listings old enough
 * to have had the chance: e.g. 7-day sell-through uses listings first seen ≥ 7 days ago.
 *
 * @param rows from Store#sellThroughRows
 * @returns { segments: [{ key, group, n, gone, sellThrough3d, sellThrough7d, sellThrough14d, medianDaysToSell, medianPrice }], overall }
 */
export function sellThrough(rows, { rules, groupBy = ['tier', 'category2', 'style', 'priceBand', 'brand'], now = Date.now(), minN = 5 } = {}) {
  const enriched = rows.map((r) => {
    const seen = new Date(r.first_seen).getTime();
    const gone = r.gone_at ? new Date(r.gone_at).getTime() : undefined;
    const isGone = r.status === 'sold' || r.status === 'removed';
    return {
      ...r,
      tier: rules ? brandTier(r.brand, rules) : 'all',
      priceBand: r.price < 50 ? '<50' : r.price < 100 ? '50-100' : r.price < 200 ? '100-200' : r.price < 500 ? '200-500' : '500+',
      ageDays: (now - seen) / (24 * HOURS),
      daysToGo: isGone && gone ? Math.max(0, (gone - seen) / (24 * HOURS)) : undefined,
      isGone,
      checked: Boolean(r.status),
    };
  }).filter((r) => r.checked); // only listings that have been re-visited at least once tell us anything

  const summarise = (list) => {
    const window = (d) => {
      const eligible = list.filter((r) => r.ageDays >= d);
      if (!eligible.length) return undefined;
      return Number((eligible.filter((r) => r.isGone && r.daysToGo !== undefined && r.daysToGo <= d).length / eligible.length).toFixed(3));
    };
    const dts = list.filter((r) => r.daysToGo !== undefined).map((r) => r.daysToGo);
    return {
      n: list.length,
      gone: list.filter((r) => r.isGone).length,
      sellThrough3d: window(3),
      sellThrough7d: window(7),
      sellThrough14d: window(14),
      medianDaysToSell: dts.length ? Number(median(dts).toFixed(1)) : undefined,
      medianPrice: list.length ? median(list.map((r) => r.price).filter(Number.isFinite)) : undefined,
    };
  };

  const segments = [];
  for (const group of groupBy) {
    const buckets = new Map();
    for (const r of enriched) {
      const key = r[group];
      if (key === undefined || key === null) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    }
    for (const [key, list] of buckets) if (list.length >= minN) segments.push({ group, key: String(key), ...summarise(list) });
  }
  segments.sort((a, b) => (b.sellThrough7d ?? -1) - (a.sellThrough7d ?? -1) || b.n - a.n);
  return { overall: summarise(enriched), segments, checked: enriched.length, total: rows.length };
}
