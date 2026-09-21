import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJevClient, interpretTriage, triageQuestions, listingState, RESALE_BANDS } from '../src/jev.js';

test('triageQuestions uses the three Jev primitives with the taxonomy as choice options', () => {
  const q = triageQuestions();
  assert.equal(q.worth_checking.type, 'noul');
  assert.deepEqual(Object.keys(q.worth_checking.criteria), ['true', 'false']);
  assert.equal(q.category.type, 'choice');
  assert.ok(Object.keys(q.category.criteria).length > 10 && Object.keys(q.category.criteria).length <= 255);
  assert.ok('other' in q.category.criteria);
  assert.deepEqual(Object.keys(q.resale_band.criteria), Object.keys(RESALE_BANDS));
});

test('interpretTriage combines the answers into the pipeline triage shape', () => {
  const good = interpretTriage({ worth_checking: { noul: 0.9 }, is_packaging: { noul: 0.05 }, replica_signal: { noul: 0.1 }, category: { choice: 'crossbody_bag', confidence: 0.8 }, gender: { choice: 'women', confidence: 0.9 }, resale_band: { choice: '200_500', confidence: 0.6 } }, 90);
  assert.equal(good.worth_checking, true);
  assert.equal(good.est_resale_eur, 325);
  assert.equal(good.category, 'crossbody bag');
  assert.equal(good.gender, 'women');
  assert.match(good.reason, /resale ~325/);
  const packaging = interpretTriage({ worth_checking: { noul: 0.7 }, is_packaging: { noul: 0.95 }, replica_signal: { noul: 0 }, resale_band: { choice: 'under_50' } }, 10);
  assert.equal(packaging.worth_checking, false);
  const overpriced = interpretTriage({ worth_checking: { noul: 0.8 }, is_packaging: { noul: 0 }, replica_signal: { noul: 0 }, resale_band: { choice: '50_100' } }, 120);
  assert.equal(overpriced.worth_checking, false); // band midpoint 75 < price 120: the comparison is done in code, not by Jev
});

test('createJevClient posts one request per listing with the expected shape and returns a Map', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, auth: init.headers.authorization, body });
    return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: { worth_checking: { type: 'noul', noul: 0.8, confidence: 0.7 }, is_packaging: { noul: 0.02 }, replica_signal: { noul: 0.01 }, category: { choice: 'sneakers', probabilities: {}, confidence: 0.9 }, gender: { choice: 'men', confidence: 0.8 }, resale_band: { choice: '100_200', confidence: 0.5 } }, usage: { input_tokens: 180, output_tokens: 0 } }) };
  };
  const jev = createJevClient({ apiKey: 'k', fetchImpl });
  const out = await jev.triage([{ id: 1, brand: 'Prada', title: 'Prada sneakers', price: 60 }, { id: 2, brand: 'Loewe', title: 'Loewe bag', price: 400 }]);
  assert.equal(calls.length, 3); // gate + labels for the pick, gate only for the overpriced one
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls.filter((c) => c.body.questions.category).length, 1); // category only in the second stage, only for the pick
  assert.equal(calls.filter((c) => c.body.questions.worth_checking).length, 2); // gate for both
  assert.equal(calls[0].auth, 'Bearer k');
  assert.equal(calls[0].body.model, 'jev-latest');
  assert.equal(calls[0].body.state.brand, 'Prada');
  assert.equal(out.get(1).worth_checking, true);
  assert.equal(out.get(1).est_resale_eur, 150);
  assert.equal(out.get(1).category, 'sneakers');
  assert.equal(out.get(2).worth_checking, false); // 150 < 400
  assert.ok(jev.spentUsd > 0);
  assert.equal(createJevClient({ apiKey: undefined }), undefined);
});

test('listingState keeps only the fields Jev should judge from', () => {
  const s = listingState({ id: 1, brand: 'Dior', title: 't', size: 'M', condition: 'Good', price: 80, photos: ['x'], detail: { description: 'd'.repeat(2000), seller: { feedbackCount: 12 } } });
  assert.equal(s.description.length, 800);
  assert.equal(s.seller_reviews, 12);
  assert.equal('photos' in s, false);
});
