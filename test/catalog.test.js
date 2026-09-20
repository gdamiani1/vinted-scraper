import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCatalogUrl, parseCatalogFlight, normalizeItem, splitItemBox } from '../src/catalog.js';

const catalog = readFileSync(new URL('./fixtures/catalog.flight.txt', import.meta.url), 'utf8');

test('buildCatalogUrl encodes all supported filters with Vinted param names', () => {
  const url = buildCatalogUrl('https://www.vinted.hr', {
    query: 'nike air max', page: 2, order: 'newest', priceFrom: 10, priceTo: 50,
    brandIds: [53, 88], catalogIds: [1904], sizeIds: [207], statusIds: [6, 1], colorIds: [1], currency: 'EUR',
  });
  const u = new URL(url);
  assert.equal(u.pathname, '/catalog');
  assert.equal(u.searchParams.get('search_text'), 'nike air max');
  assert.equal(u.searchParams.get('page'), '2');
  assert.equal(u.searchParams.get('order'), 'newest_first');
  assert.equal(u.searchParams.get('price_from'), '10');
  assert.equal(u.searchParams.get('price_to'), '50');
  assert.deepEqual(u.searchParams.getAll('brand_ids[]'), ['53', '88']);
  assert.deepEqual(u.searchParams.getAll('catalog[]'), ['1904']);
  assert.deepEqual(u.searchParams.getAll('size_ids[]'), ['207']);
  assert.deepEqual(u.searchParams.getAll('status_ids[]'), ['6', '1']);
  assert.deepEqual(u.searchParams.getAll('color_ids[]'), ['1']);
  assert.equal(u.searchParams.get('currency'), 'EUR');
});

test('buildCatalogUrl accepts raw Vinted order values and omits empty filters', () => {
  const u = new URL(buildCatalogUrl('https://www.vinted.fr', { order: 'price_high_to_low' }));
  assert.equal(u.searchParams.get('order'), 'price_high_to_low');
  assert.equal(u.searchParams.has('search_text'), false);
  assert.equal(u.searchParams.has('price_from'), false);
});

test('buildCatalogUrl rejects unknown order', () => {
  assert.throws(() => buildCatalogUrl('https://www.vinted.hr', { order: 'bogus' }), /order/);
});

test('parseCatalogFlight extracts items and pagination', () => {
  const { items, pagination } = parseCatalogFlight(catalog);
  assert.equal(items.length, 5);
  assert.equal(pagination.currentPage, 1);
  assert.equal(pagination.totalPages, 10);
  assert.equal(pagination.totalEntries, 960);
  assert.equal(pagination.perPage, 96);
});

test('parseCatalogFlight throws a descriptive error on session-refresh page', () => {
  const html = readFileSync(new URL('./fixtures/session-refresh.html', import.meta.url), 'utf8');
  assert.throws(() => parseCatalogFlight(html), /session/i);
});

test('normalizeItem produces a flat, typed listing', () => {
  const { items } = parseCatalogFlight(catalog);
  const item = normalizeItem(items[0], 'https://www.vinted.hr');
  assert.equal(item.id, 10068110804);
  assert.equal(item.title, 'Bluza');
  assert.equal(item.url, 'https://www.vinted.hr/items/10068110804-bluza');
  assert.equal(item.price, 9.04);
  assert.equal(item.currency, 'EUR');
  assert.equal(item.totalPrice, 10.19);
  assert.equal(item.serviceFee, 1.15);
  assert.equal(item.brand, 'Nike Air');
  assert.equal(item.size, 'S / 36 / 8');
  assert.equal(item.condition, 'Veoma dobro');
  assert.equal(item.conditionId, 2);
  assert.equal(item.sellerId, 91325435);
  assert.equal(item.sellerIsBusiness, false);
  assert.equal(item.favouriteCount, 0);
  assert.equal(item.isPromoted, false);
  assert.match(item.thumbnail, /^https:\/\/images1\.vinted\.net/);
  assert.ok(item.photos.length >= 1);
  assert.match(item.photos[0], /f800/);
  assert.equal(typeof item.searchScore, 'number');
});

test('splitItemBox separates size and condition, and recognises condition-only lines', () => {
  assert.deepEqual(splitItemBox('S / 36 / 8 · Veoma dobro'), { size: 'S / 36 / 8', condition: 'Veoma dobro', conditionId: 2 });
  assert.deepEqual(splitItemBox('Novo s etiketama'), { size: undefined, condition: 'Novo s etiketama', conditionId: 6 });
  assert.deepEqual(splitItemBox('New with tags'), { size: undefined, condition: 'New with tags', conditionId: 6 });
  assert.deepEqual(splitItemBox('42'), { size: '42', condition: undefined, conditionId: undefined });
  assert.deepEqual(splitItemBox(''), { size: undefined, condition: undefined, conditionId: undefined });
});

test('titleFilter applies include/exclude regexes to title and brand', async () => {
  const { titleFilter } = await import('../src/scraper.js');
  const keep = titleFilter(['air ?max'], ['tee|jersey']);
  assert.equal(keep({ title: 'Nike Air Max 90', brand: 'Nike' }), true);
  assert.equal(keep({ title: 'Nike Airmax tee', brand: 'Nike' }), false);
  assert.equal(keep({ title: 'Nike Dunk', brand: 'Nike' }), false);
  assert.equal(titleFilter()({ title: 'anything' }), true);
});
