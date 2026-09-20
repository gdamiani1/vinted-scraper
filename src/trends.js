/**
 * Trend detection and forecasting over the listings we have seen.
 *
 * Supply is measured as each segment's SHARE of the listings first seen that day (robust to how
 * much we crawled), price as the median asking price, demand as the sell-through of listings
 * that have been re-checked. Trends compare the recent window with the one before it; forecasts
 * use Holt's linear exponential smoothing on the daily series and refuse to forecast on thin data.
 */
import { median } from './deals.js';
import { brandTier } from './rules.js';

const DAY = 864e5;
const dayKey = (iso) => iso.slice(0, 10);

export function buildSeries(rows, { rules, groupBy = ['category2', 'style', 'brand', 'tier', 'color2', 'priceBand'], days = 28, now = Date.now() } = {}) {
  const start = now - days * DAY;
  const daily = new Map(); // day -> total listings seen
  const seg = new Map(); // group|key -> day -> { n, prices[], checked, gone }
  for (const r of rows) {
    const seen = new Date(r.first_seen).getTime();
    if (!(seen >= start)) continue;
    const day = dayKey(r.first_seen);
    daily.set(day, (daily.get(day) ?? 0) + 1);
    const enriched = { ...r, tier: rules ? brandTier(r.brand, rules) : undefined, priceBand: r.price < 50 ? '<50' : r.price < 100 ? '50-100' : r.price < 200 ? '100-200' : r.price < 500 ? '200-500' : '500+' };
    for (const g of groupBy) {
      const key = enriched[g];
      if (key === undefined || key === null || key === '') continue;
      const id = `${g}|${key}`;
      if (!seg.has(id)) seg.set(id, { group: g, key: String(key), days: new Map() });
      const d = seg.get(id).days;
      if (!d.has(day)) d.set(day, { n: 0, prices: [], checked: 0, gone: 0 });
      const cell = d.get(day);
      cell.n++;
      if (Number.isFinite(r.price)) cell.prices.push(r.price);
      if (r.status) { cell.checked++; if (r.status === 'sold' || r.status === 'removed') cell.gone++; }
    }
  }
  const dayList = [...daily.keys()].sort();
  const series = [];
  for (const s of seg.values()) {
    const points = dayList.map((day) => {
      const c = s.days.get(day);
      return { day, n: c?.n ?? 0, share: c ? c.n / daily.get(day) : 0, medianPrice: c?.prices.length ? median(c.prices) : undefined, checked: c?.checked ?? 0, gone: c?.gone ?? 0 };
    });
    series.push({ group: s.group, key: s.key, points, total: points.reduce((a, p) => a + p.n, 0) });
  }
  return { series, days: dayList, dailyTotals: Object.fromEntries(daily) };
}

/** Holt's linear exponential smoothing. Returns level/trend and a horizon forecast, or null when too thin. */
export function holtForecast(values, { horizon = 7, alpha = 0.5, beta = 0.3, minPoints = 10 } = {}) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < minPoints) return null;
  let level = v[0];
  let trend = v[1] - v[0];
  const residuals = [];
  for (let i = 1; i < v.length; i++) {
    const prev = level + trend;
    residuals.push(v[i] - prev);
    const newLevel = alpha * v[i] + (1 - alpha) * (level + trend);
    trend = beta * (newLevel - level) + (1 - beta) * trend;
    level = newLevel;
  }
  const sd = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / residuals.length) || 0;
  const forecast = Array.from({ length: horizon }, (_, h) => level + trend * (h + 1));
  return { level, trend, sd, forecast, next: forecast[0], atHorizon: forecast[horizon - 1], points: v.length };
}

const pct = (a, b) => (b ? (a - b) / b : undefined);
const round = (x, d = 3) => (x === undefined || x === null || !Number.isFinite(x) ? undefined : Number(x.toFixed(d)));

/**
 * Compares the last `recentDays` with the window before and scores momentum:
 *   + supply share rising, + price rising, + sell-through rising → "rising" (demand outpacing supply)
 *   share rising but price/sell-through falling → "flooding" (supply outpacing demand)
 */
export function detectTrends({ series, days }, { recentDays = 7, minTotal = 20 } = {}) {
  const cut = days.length - recentDays;
  const out = [];
  for (const s of series) {
    if (s.total < minTotal) continue;
    const recent = s.points.slice(Math.max(0, cut));
    const before = s.points.slice(0, Math.max(0, cut));
    const agg = (pts) => {
      const n = pts.reduce((a, p) => a + p.n, 0);
      const checked = pts.reduce((a, p) => a + p.checked, 0);
      const gone = pts.reduce((a, p) => a + p.gone, 0);
      const prices = pts.flatMap((p) => (p.medianPrice !== undefined ? [p.medianPrice] : []));
      return { n, share: pts.length ? pts.reduce((a, p) => a + p.share, 0) / pts.length : 0, price: prices.length ? median(prices) : undefined, sellThrough: checked ? gone / checked : undefined, daysWithData: pts.filter((p) => p.n > 0).length };
    };
    const a = agg(recent), b = agg(before);
    const shareChange = pct(a.share, b.share);
    const priceChange = pct(a.price, b.price);
    const stChange = a.sellThrough !== undefined && b.sellThrough !== undefined ? a.sellThrough - b.sellThrough : undefined;
    const enough = b.n >= 10 && a.n >= 10;
    let momentum = 0;
    if (enough) {
      momentum += Math.max(-1, Math.min(1, shareChange ?? 0)) * 30;
      momentum += Math.max(-1, Math.min(1, priceChange ?? 0)) * 40;
      momentum += Math.max(-1, Math.min(1, (stChange ?? 0) * 2)) * 30;
    }
    const label = !enough ? 'insufficient data' : momentum >= 15 ? 'rising' : momentum <= -15 ? 'cooling' : (shareChange ?? 0) > 0.3 && (priceChange ?? 0) < 0 ? 'flooding' : 'stable';
    const shareFc = holtForecast(s.points.map((p) => p.share));
    const priceFc = holtForecast(s.points.map((p) => p.medianPrice));
    out.push({
      group: s.group, key: s.key, total: s.total, label, momentum: round(momentum, 0),
      recent: { n: a.n, share: round(a.share), price: round(a.price, 2), sellThrough: round(a.sellThrough), daysWithData: a.daysWithData },
      before: { n: b.n, share: round(b.share), price: round(b.price, 2), sellThrough: round(b.sellThrough) },
      shareChange: round(shareChange), priceChange: round(priceChange), sellThroughChange: round(stChange),
      forecast: shareFc || priceFc ? { shareNext7d: shareFc ? round(shareFc.atHorizon) : undefined, priceNext7d: priceFc ? round(priceFc.atHorizon, 2) : undefined, basedOnDays: (shareFc ?? priceFc).points } : undefined,
    });
  }
  out.sort((x, y) => (y.momentum ?? -999) - (x.momentum ?? -999) || y.total - x.total);
  return out;
}

/** Plain-language summary lines a human can act on, without a model. */
export function summarize(trends, { top = 5 } = {}) {
  const usable = trends.filter((t) => t.label !== 'insufficient data');
  const rising = usable.filter((t) => t.label === 'rising').slice(0, top);
  const cooling = usable.filter((t) => t.label === 'cooling').slice(0, top);
  const flooding = usable.filter((t) => t.label === 'flooding').slice(0, top);
  const fmt = (t) => `${t.group.replace('2', '')} "${t.key}" (share ${t.shareChange !== undefined ? (t.shareChange >= 0 ? '+' : '') + Math.round(t.shareChange * 100) + '%' : 'n/a'}, price ${t.priceChange !== undefined ? (t.priceChange >= 0 ? '+' : '') + Math.round(t.priceChange * 100) + '%' : 'n/a'}${t.sellThroughChange !== undefined ? `, sell-through ${t.sellThroughChange >= 0 ? '+' : ''}${Math.round(t.sellThroughChange * 100)} pts` : ''})`;
  const lines = [];
  lines.push(`${usable.length} of ${trends.length} segments have enough history to compare; ${trends.length - usable.length} need more days.`);
  if (rising.length) lines.push('Rising: ' + rising.map(fmt).join('; '));
  if (flooding.length) lines.push('Flooding (supply up, price down): ' + flooding.map(fmt).join('; '));
  if (cooling.length) lines.push('Cooling: ' + cooling.map(fmt).join('; '));
  if (!rising.length && !cooling.length && !flooding.length) lines.push('No segment has moved beyond noise yet.');
  return lines;
}
