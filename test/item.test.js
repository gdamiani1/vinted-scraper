import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseItemFlight, parseItemId } from '../src/item.js';

const flight = readFileSync(new URL('./fixtures/item.flight.txt', import.meta.url), 'utf8');

test('parseItemId accepts ids, paths and full urls', () => {
  assert.equal(parseItemId('10068078703'), 10068078703);
  assert.equal(parseItemId(10068078703), 10068078703);
  assert.equal(parseItemId('/items/10068078703-buty-sportowe'), 10068078703);
  assert.equal(parseItemId('https://www.vinted.hr/items/10068078703-buty?referrer=catalog'), 10068078703);
  assert.throws(() => parseItemId('nope'), /item id/i);
});

test('parseItemFlight extracts the full item detail', () => {
  const d = parseItemFlight(flight, 'https://www.vinted.hr');
  assert.equal(d.id, 10068078703);
  assert.equal(d.title, 'Buty sportowe, Nike Air Max, roz. 34');
  assert.equal(d.url, 'https://www.vinted.hr/items/10068078703-buty-sportowe-nike-air-max-roz-34');
  assert.equal(d.description, 'Stan bardzo dobry, fajne kolorki');
  assert.deepEqual(d.brand, { id: 5977, title: 'Nike Air' });
  assert.equal(d.catalogId, 2718);
  assert.deepEqual(d.size, { id: 512, value: '34' });
  assert.equal(d.condition, 'Veoma dobro');
  assert.equal(d.conditionId, 2);
  assert.equal(d.color, 'Bijela, Ruža');
  assert.equal(d.uploadedAgo, 'prije 2 min');
  assert.equal(d.price, 60);
  assert.equal(d.currency, 'PLN');
  assert.equal(d.buyerPrice, 15.31);
  assert.equal(d.buyerCurrency, 'EUR');
  assert.equal(d.buyerProtectionFee, 1.4);
  assert.deepEqual(d.shipping, { price: 3.3, currency: 'EUR', isFree: false, pickupOnly: false, multipleOptions: true });
  assert.ok(d.photos.length >= 2);
  assert.match(d.photos[0], /f800/);
  assert.deepEqual(d.seller, {
    id: 90402166, name: 'kh-kh', feedbackCount: 389, feedbackReputation: 1, business: false,
    badges: ['ACTIVE_LISTER', 'SPEEDY_SHIPPING'], lastActive: 'Zadnja aktivnost prije 39 min',
    url: 'https://www.vinted.hr/member/90402166',
  });
  assert.deepEqual(d.flags, { canBuy: true, isReserved: false, isHidden: false, instantBuy: true });
  assert.ok(Array.isArray(d.attributes) && d.attributes.length >= 4);
});
