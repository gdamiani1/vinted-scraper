import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelEmbedding, cosine, rankBySimilarity, vecToBlob, blobToVec, TAXONOMY, knnLabels } from '../src/embed.js';
import { Store } from '../src/store.js';

const unit = (arr) => { const n = Math.hypot(...arr); return Float32Array.from(arr, (x) => x / n); };

test('labelEmbedding picks the closest prompt per group and lists top styles', () => {
  const groups = {
    category: [{ label: 'sneakers', vecs: [unit([1, 0, 0])] }, { label: 'handbag', vecs: [unit([0, 1, 0])] }],
    style: [{ label: 'streetwear', vecs: [unit([1, 0.2, 0])] }, { label: 'evening', vecs: [unit([0, 0, 1])] }, { label: 'vintage', vecs: [unit([0.5, 0.5, 0])] }],
  };
  const out = labelEmbedding(unit([1, 0.1, 0]), groups, { minConfidence: {} });
  assert.equal(out.category, 'sneakers');
  assert.ok(out.categoryConfidence > 0.5);
  assert.equal(out.style, 'streetwear');
  assert.equal(out.styles.length, 3);
  assert.equal(out.styles[0].label, 'streetwear');
});

test('cosine and rankBySimilarity order by similarity and can exclude the query item', () => {
  const rows = [{ id: 1, vec: unit([1, 0]) }, { id: 2, vec: unit([0.9, 0.1]) }, { id: 3, vec: unit([0, 1]) }];
  assert.ok(Math.abs(cosine(rows[0].vec, rows[0].vec) - 1) < 1e-6);
  const ranked = rankBySimilarity(unit([1, 0]), rows, { exclude: 1 });
  assert.deepEqual(ranked.map((r) => r.id), [2, 3]);
});

test('vectors round-trip through the store as blobs, with labels on the item row', () => {
  const store = new Store(':memory:');
  store.recordSeen('q', [{ id: 7, title: 'x', price: 10, currency: 'EUR' }]);
  const vec = unit([0.1, 0.2, 0.3, 0.4]);
  store.putEmbedding(7, vec, 'test-model', { category: 'boots', style: 'gorpcore', color: 'black', material: 'suede', gender: 'men', styles: [{ label: 'gorpcore', p: 0.6 }] });
  const back = blobToVec(vecToBlob(vec));
  assert.ok(Math.abs(back[2] - vec[2]) < 1e-6);
  const all = store.allEmbeddings();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 7);
  assert.equal(all[0].vec.length, 4);
  assert.deepEqual(store.itemsNeedingEmbedding(10), []);
  const [row] = store.list({ category: 'boots' });
  assert.equal(row.id, 7);
  assert.equal(store.list({ style: 'evening' }).length, 0);
  assert.equal(store.list({ color: 'black', gender: 'men' }).length, 1);
  store.close();
});

test('taxonomy groups are non-empty and every label has at least one prompt', () => {
  for (const [g, labels] of Object.entries(TAXONOMY)) {
    assert.ok(Object.keys(labels).length > 1, g);
    for (const [l, ps] of Object.entries(labels)) assert.ok(ps.length >= 1, `${g}/${l}`);
  }
});

test('labelEmbedding blanks weak labels below the confidence threshold', () => {
  const groups = { color: [{ label: 'black', vecs: [unit([1, 0])] }, { label: 'navy', vecs: [unit([0.99, 0.14])] }, { label: 'grey', vecs: [unit([0.98, 0.2])] }] };
  const out = labelEmbedding(unit([1, 0.1]), groups, { minConfidence: { color: 0.9 } });
  assert.equal(out.color, null);
  assert.ok(out.colorConfidence < 0.9);
});

test('knnLabels votes from close human-tagged neighbours and stays silent otherwise', () => {
  const ex = (id, field, value, v) => ({ id, field, value, vec: unit(v) });
  const examples = [ex(1, 'style', 'quiet luxury', [1, 0, 0]), ex(2, 'style', 'quiet luxury', [0.98, 0.1, 0]), ex(3, 'style', 'quiet luxury', [0.97, 0.15, 0]), ex(4, 'style', 'streetwear', [0, 1, 0]), ex(5, 'style', 'streetwear', [0.1, 0.99, 0]), ex(6, 'style', 'quiet luxury', [0.99, 0.05, 0.05])];
  const near = knnLabels(unit([1, 0.05, 0]), examples);
  assert.equal(near.style, 'quiet luxury');
  assert.equal(near.styleSource, 'knn');
  assert.deepEqual(knnLabels(unit([0, 0, 1]), examples), {}); // nothing similar enough
  assert.deepEqual(knnLabels(unit([1, 0, 0]), examples.slice(0, 3)), {}); // too few tags for the field
  assert.equal(knnLabels(unit([1, 0, 0]), examples, { exclude: 1 }).style, 'quiet luxury');
});

test('human tags override automatic labels and survive relabelling', () => {
  const store = new Store(':memory:');
  store.recordSeen('q', [{ id: 9, title: 'x', price: 10, currency: 'EUR' }]);
  store.putEmbedding(9, unit([1, 0, 0, 0]), 'm', { category: 'shirt', style: 'y2k', color: 'beige' });
  store.setHumanLabel(9, 'category', 'sweatshirt');
  store.setHumanLabel(9, 'style', null);
  let [row] = store.list({ ids: [9] });
  assert.equal(row.category2, 'sweatshirt');
  assert.equal(row.style, undefined);
  assert.equal(row.labels.human.category, 'sweatshirt');
  store.applyLabels(9, { category: 'shirt', style: 'y2k', color: 'grey' }); // an automatic relabel
  [row] = store.list({ ids: [9] });
  assert.equal(row.category2, 'sweatshirt'); // human wins
  assert.equal(row.color2, 'grey'); // untagged field follows the automatic label
  assert.equal(row.labels.autoCategory, 'shirt'); // automatic guess kept for calibration
  assert.deepEqual(store.humanStats().counts, { category: 1, style: 1 });
  assert.equal(store.humanExamples().length, 2);
  store.close();
});
