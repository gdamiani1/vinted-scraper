import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

const mk = (id, price) => ({ id, price, currency: 'EUR', title: `t${id}`, url: `https://x/items/${id}`, brand: 'B', condition: 'C', conditionId: 2 });

test('Store reports new items and price drops across runs', () => {
  const store = new Store(':memory:');
  const r1 = store.recordSeen('nike', [mk(1, 10), mk(2, 20)]);
  assert.deepEqual(r1.newItems.map((i) => i.id), [1, 2]);
  assert.deepEqual(r1.priceDrops, []);
  const r2 = store.recordSeen('nike', [mk(1, 10), mk(2, 15), mk(3, 30)]);
  assert.deepEqual(r2.newItems.map((i) => i.id), [3]);
  assert.equal(r2.priceDrops.length, 1);
  assert.equal(r2.priceDrops[0].id, 2);
  assert.equal(r2.priceDrops[0].previousPrice, 20);
  assert.equal(r2.priceDrops[0].price, 15);
  assert.equal(store.count(), 3);
  const hist = store.priceHistory(2);
  assert.deepEqual(hist.map((h) => h.price), [20, 15]);
  store.close();
});

test('Store baseline groups historical prices by comparable key', () => {
  const store = new Store(':memory:');
  store.recordSeen('q', [mk(1, 10), mk(2, 20)]);
  const b = store.baseline();
  assert.deepEqual(b['B|2'].sort(), [10, 20]);
  store.close();
});

test('Store persists triage potential and lists pending picks by upside', () => {
  const store = new Store(':memory:');
  const items = [mk(1, 100), mk(2, 100), mk(3, 100)];
  store.recordSeen('h', items);
  store.setTriage([
    { ...items[0], triage: { worth_checking: true, est_resale_eur: 300, reason: 'a' } },
    { ...items[1], triage: { worth_checking: true, est_resale_eur: 120, reason: 'b' } },
    { ...items[2], triage: { worth_checking: false, est_resale_eur: 500, reason: 'c' } },
  ]);
  assert.deepEqual(store.pendingPotential(0.5).map((i) => i.id), [1]);
  assert.deepEqual(store.pendingPotential(0.1).map((i) => i.id), [1, 2]);
  store.setBuyScores([{ ...items[0], buy: { score: 70 } }]);
  assert.deepEqual(store.pendingPotential(0.1).map((i) => i.id), [2]);
  assert.equal(store.list({ sort: 'potential', limit: 1 })[0].id, 1);
  store.close();
});
