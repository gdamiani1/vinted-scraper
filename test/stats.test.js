import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sellThrough } from '../src/stats.js';
import { loadRules } from '../src/rules.js';

const rules = loadRules();
const day = 864e5;
const now = Date.UTC(2026, 8, 20);
const row = (brand, price, daysAgo, status, goneAfterDays, category2 = 'handbag') => ({
  brand, price, currency: 'EUR', category2, style: 'classic', color2: 'black',
  first_seen: new Date(now - daysAgo * day).toISOString(), status, gone_at: goneAfterDays !== undefined ? new Date(now - daysAgo * day + goneAfterDays * day).toISOString() : null,
});

test('sellThrough measures survival only over listings old enough, and groups by tier/category/price band', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => row('Chanel', 900, 10, i < 3 ? 'sold' : 'available', i < 3 ? 2 : undefined)),
    ...Array.from({ length: 5 }, (_, i) => row('COS', 40, 10, i < 1 ? 'removed' : 'available', i < 1 ? 5 : undefined, 'coat')),
    row('Prada', 300, 1, 'available'), // too young to count toward 3-day sell-through
    row('Prada', 300, 1, undefined), // never rechecked: ignored entirely
  ];
  const s = sellThrough(rows, { rules, now, minN: 5 });
  assert.equal(s.checked, 11);
  assert.equal(s.total, 12);
  const tier1 = s.segments.find((x) => x.group === 'tier' && x.key === 'tier1');
  assert.equal(tier1.n, 6);
  assert.equal(tier1.sellThrough3d, 0.6); // 3 of the 5 old-enough Chanel rows sold within 3 days
  assert.equal(tier1.sellThrough7d, 0.6);
  assert.equal(tier1.medianDaysToSell, 2);
  const tier3 = s.segments.find((x) => x.group === 'tier' && x.key === 'tier3');
  assert.equal(tier3.sellThrough7d, 0.2);
  const bags = s.segments.find((x) => x.group === 'category2' && x.key === 'handbag');
  assert.equal(bags.n, 6);
  assert.equal(s.segments[0].key, 'tier1'); // best sell-through first
  assert.ok(s.overall.n === 11 && s.overall.gone === 4);
});
