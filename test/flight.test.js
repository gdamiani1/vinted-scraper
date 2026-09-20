import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractBalanced, findObjects, findObjectAfterKey, stripUndefined } from '../src/flight.js';

const catalog = readFileSync(new URL('./fixtures/catalog.flight.txt', import.meta.url), 'utf8');

test('extractBalanced returns a complete JSON object even with braces inside strings', () => {
  const text = 'xx {"a":"} {","b":[1,{"c":"\\"}"}]} trailing';
  const start = text.indexOf('{');
  const { json, end } = extractBalanced(text, start);
  assert.deepEqual(JSON.parse(json), { a: '} {', b: [1, { c: '"}' }] });
  assert.equal(text.slice(end), ' trailing');
});

test('findObjectAfterKey locates the object following a key', () => {
  const store = findObjectAfterKey(catalog, '"items":{"items":[');
  assert.ok(store);
  assert.equal(store.items.length, 5);
  assert.equal(store.pagination.per_page, 96);
});

test('findObjects yields every object matching a predicate', () => {
  const found = findObjects(catalog, '{"id":', (o) => o.productItem && o.catalogTracking);
  assert.equal(found.length, 5);
});

test('stripUndefined converts RSC "$undefined" placeholders', () => {
  const out = stripUndefined({ a: '$undefined', b: [1, '$undefined', { c: '$undefined', d: 2 }] });
  assert.deepEqual(out, { a: undefined, b: [1, undefined, { c: undefined, d: 2 }] });
});
