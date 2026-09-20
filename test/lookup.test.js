import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONDITIONS, resolveCondition, flattenCatalogs, bestMatch } from '../src/lookup.js';

test('resolveCondition maps names, aliases and ids to Vinted status ids', () => {
  assert.equal(resolveCondition('new'), 6);
  assert.equal(resolveCondition('new with tags'), 6);
  assert.equal(resolveCondition('nwt'), 6);
  assert.equal(resolveCondition('new without tags'), 1);
  assert.equal(resolveCondition('very good'), 2);
  assert.equal(resolveCondition('good'), 3);
  assert.equal(resolveCondition('satisfactory'), 4);
  assert.equal(resolveCondition('2'), 2);
  assert.equal(resolveCondition('novo s etiketama'), 6);
  assert.throws(() => resolveCondition('mint'), /condition/i);
  assert.equal(Object.keys(CONDITIONS).length, 5);
});

test('flattenCatalogs walks the tree with paths', () => {
  const tree = [{ id: 1, title: 'Women', catalogs: [{ id: 2, title: 'Shoes', catalogs: [{ id: 3, title: 'Trainers', catalogs: [] }] }] }];
  const flat = flattenCatalogs(tree);
  assert.deepEqual(flat.map((c) => [c.id, c.path]), [[1, 'Women'], [2, 'Women > Shoes'], [3, 'Women > Shoes > Trainers']]);
});

test('bestMatch prefers exact, then prefix, then substring matches (case/diacritic-insensitive)', () => {
  const list = [{ id: 1, title: 'Nike Air' }, { id: 2, title: 'Nike' }, { id: 3, title: 'Nikita' }, { id: 4, title: 'Tenisice' }];
  assert.equal(bestMatch(list, 'nike').id, 2);
  assert.equal(bestMatch(list, 'nike ai').id, 1);
  assert.equal(bestMatch(list, 'tenisiće').id, 4);
  assert.equal(bestMatch(list, 'zzz'), undefined);
});

test('flattenCatalogs derives English slugs from urls and bestMatch searches several keys', () => {
  const tree = [{ id: 1904, title: 'Žene', url: '/catalog/1904-women', catalogs: [{ id: 1841, title: 'Traperice', url: '/catalog/1841-jeans', catalogs: [] }, { id: 2632, title: 'Tenisice', url: '/catalog/2632-trainers', catalogs: [] }] }];
  const flat = flattenCatalogs(tree);
  assert.equal(flat.find((c) => c.id === 1841).slug, 'jeans');
  assert.equal(bestMatch(flat, 'jeans', ['title', 'slug', 'path']).id, 1841);
  assert.equal(bestMatch(flat, 'traperice', ['title', 'slug', 'path']).id, 1841);
  assert.equal(bestMatch(flat, 'trainers', ['title', 'slug', 'path']).id, 2632);
});
