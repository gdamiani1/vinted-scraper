import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreDeals, median } from '../src/deals.js';

const mk = (id, price, extra = {}) => ({ id, price, currency: 'EUR', title: `item ${id}`, brand: 'Nike', condition: 'Very good', conditionId: 2, isPromoted: false, ...extra });

test('median handles odd/even/empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), undefined);
});

test('scoreDeals flags items well below the comparable median', () => {
  const items = [mk(1, 10), mk(2, 40), mk(3, 42), mk(4, 45), mk(5, 50), mk(6, 48)];
  const scored = scoreDeals(items);
  const byId = Object.fromEntries(scored.map((s) => [s.id, s]));
  assert.ok(byId[1].deal.score > byId[2].deal.score);
  assert.ok(byId[1].deal.belowMedianPct > 0.7);
  assert.equal(byId[1].deal.comparableCount, 5);
  assert.ok(byId[1].deal.reasons.some((r) => /below/i.test(r)));
  assert.ok(byId[5].deal.belowMedianPct < 0);
});

test('scoreDeals groups comparables by brand+condition when groups are large enough', () => {
  const nike = [10, 11, 12, 13, 14, 5].map((p, i) => mk(100 + i, p, { brand: 'Nike' }));
  const gucci = [200, 210, 220, 230, 240, 100].map((p, i) => mk(200 + i, p, { brand: 'Gucci' }));
  const scored = scoreDeals([...nike, ...gucci]);
  const cheapGucci = scored.find((s) => s.id === 205);
  assert.equal(cheapGucci.deal.comparableKey, 'Gucci|2');
  assert.equal(cheapGucci.deal.comparableCount, 5);
  assert.ok(cheapGucci.deal.belowMedianPct > 0.4);
});

test('scoreDeals rewards new-with-tags keywords and sorts by score when asked', () => {
  const items = [mk(1, 30, { title: 'Nike hoodie novo s etiketom', conditionId: 6 }), mk(2, 30), mk(3, 31), mk(4, 29), mk(5, 30)];
  const scored = scoreDeals(items, { sort: true });
  assert.equal(scored[0].id, 1);
  assert.ok(scored[0].deal.reasons.some((r) => /new/i.test(r)));
});

test('scoreDeals can use external price history as the baseline', () => {
  const items = [mk(1, 20)];
  const scored = scoreDeals(items, { baseline: { 'Nike|2': [50, 55, 60, 45, 52] } });
  assert.ok(scored[0].deal.belowMedianPct > 0.5);
  assert.equal(scored[0].deal.comparableCount, 5);
});
