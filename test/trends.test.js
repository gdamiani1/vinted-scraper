import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, holtForecast, detectTrends, summarize } from '../src/trends.js';
import { loadRules } from '../src/rules.js';

const rules = loadRules();
const DAY = 864e5;
const now = Date.UTC(2026, 8, 20, 12);

function synth() {
  // 28 days: "quiet luxury" share grows from 5% to 20% with rising prices; "y2k" share shrinks; "vintage" flat
  const rows = [];
  for (let d = 27; d >= 0; d--) {
    const t = 27 - d;
    const first = new Date(now - d * DAY).toISOString();
    const push = (style, n, price, soldFrac) => { for (let i = 0; i < n; i++) rows.push({ brand: 'Prada', price, currency: 'EUR', category2: 'handbag', style, color2: 'black', first_seen: first, status: i / n < soldFrac ? 'sold' : 'available', gone_at: i / n < soldFrac ? new Date(now - d * DAY + DAY).toISOString() : null }); };
    push('quiet luxury', 5 + t, 100 + t * 5, 0.3 + t * 0.01);
    push('y2k', 25 - t * 0.5, 80 - t, 0.3 - t * 0.005);
    push('vintage', 20, 60, 0.2);
  }
  return rows;
}

test('buildSeries produces one point per day per segment with share and median price', () => {
  const { series, days } = buildSeries(synth(), { rules, days: 28, now });
  assert.equal(days.length, 28);
  const ql = series.find((s) => s.group === 'style' && s.key === 'quiet luxury');
  assert.equal(ql.points.length, 28);
  assert.ok(ql.points[27].share > ql.points[0].share);
  assert.equal(ql.points[0].medianPrice, 100);
  assert.ok(series.some((s) => s.group === 'tier' && s.key === 'tier1'));
});

test('holtForecast extrapolates a trend and refuses thin series', () => {
  const up = Array.from({ length: 14 }, (_, i) => 10 + i * 2);
  const f = holtForecast(up, { horizon: 7 });
  assert.ok(f.next > 36 && f.atHorizon > f.next, JSON.stringify(f));
  assert.equal(holtForecast([1, 2, 3]), null);
});

test('detectTrends labels rising, cooling and stable segments and forecasts share', () => {
  const trends = detectTrends(buildSeries(synth(), { rules, days: 28, now }), { recentDays: 7 });
  const by = (g, k) => trends.find((t) => t.group === g && t.key === k);
  assert.equal(by('style', 'quiet luxury').label, 'rising');
  assert.equal(by('style', 'y2k').label, 'cooling');
  assert.equal(by('style', 'vintage').label, 'stable');
  assert.ok(by('style', 'quiet luxury').shareChange > 0.2);
  assert.ok(by('style', 'quiet luxury').forecast.shareNext7d > by('style', 'quiet luxury').recent.share * 0.9);
  assert.equal(trends[0].key, 'quiet luxury'); // highest momentum first
  const lines = summarize(trends);
  assert.match(lines.join('\n'), /Rising: style "quiet luxury"/);
  assert.match(lines.join('\n'), /Cooling: style "y2k"/);
});

test('detectTrends flags insufficient data instead of guessing', () => {
  const rows = synth().filter((r) => new Date(r.first_seen).getTime() > now - 2 * DAY);
  const trends = detectTrends(buildSeries(rows, { rules, days: 28, now }), { recentDays: 7 });
  assert.ok(trends.length > 0);
  assert.ok(trends.every((t) => t.label === 'insufficient data'));
  assert.match(summarize(trends).join(' '), /need more days/);
});
