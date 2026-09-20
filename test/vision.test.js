import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVisionClient, analyzeListing, VERDICT_SCHEMA, estimateCost, normalizeVerdict } from '../src/vision.js';
import { Store } from '../src/store.js';

const listing = { id: 77, title: 'Chanel classic flap', description: 'Bought 2019, comes with dust bag', brand: 'Chanel', size: undefined, condition: 'Very good', price: 1500, currency: 'EUR', photos: ['https://img/1.webp', 'https://img/2.webp', 'https://img/3.webp', 'https://img/4.webp', 'https://img/5.webp', 'https://img/6.webp'] };

function fakeFetch(calls, content) {
  return async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 5000, completion_tokens: 300 }, model: 'qwen/qwen3.8-flash' }) };
  };
}

test('createVisionClient sends an OpenAI-compatible request with photos as image_url parts and a JSON schema', async () => {
  const calls = [];
  const verdict = { item_type: 'bag', brand_seen: 'Chanel', line_or_model: 'Classic Flap Medium', condition_grade: 'very_good', authenticity_risk: 'low', authenticity_observations: ['quilting aligned'], condition_notes: [], completeness: ['dust_bag'], photo_quality: 'real_photos', size_visible: null, resale_estimate_eur: { low: 2800, high: 3400 }, red_flags: [], summary: 'Looks genuine.', confidence: 0.7 };
  const client = createVisionClient({ apiKey: 'k', model: 'qwen/qwen3.8-flash', fetchImpl: fakeFetch(calls, JSON.stringify(verdict)), maxPhotos: 4 });
  const out = await client.analyze(listing);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer k');
  const body = calls[0].body;
  assert.equal(body.model, 'qwen/qwen3.8-flash');
  assert.equal(body.response_format.type, 'json_schema');
  assert.deepEqual(body.response_format.json_schema.schema, VERDICT_SCHEMA);
  const user = body.messages.find((m) => m.role === 'user');
  const images = user.content.filter((p) => p.type === 'image_url');
  assert.equal(images.length, 4);
  assert.equal(images[0].image_url.url, 'https://img/1.webp');
  assert.match(user.content.find((p) => p.type === 'text').text, /Chanel classic flap/);
  assert.equal(out.verdict.line_or_model, 'Classic Flap Medium');
  assert.equal(out.usage.promptTokens, 5000);
  assert.equal(out.model, 'qwen/qwen3.8-flash');
});

test('createVisionClient tolerates JSON wrapped in code fences', async () => {
  const client = createVisionClient({ apiKey: 'k', fetchImpl: fakeFetch([], '```json\n{"item_type":"shoes","authenticity_risk":"medium","confidence":0.5}\n```') });
  const out = await client.analyze(listing);
  assert.equal(out.verdict.item_type, 'shoes');
});

test('analyzeListing caches verdicts per item and model in the store', async () => {
  const store = new Store(':memory:');
  const calls = [];
  const client = createVisionClient({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch(calls, '{"item_type":"bag","authenticity_risk":"low","confidence":0.9}') });
  const a = await analyzeListing(listing, { client, store });
  const b = await analyzeListing(listing, { client, store });
  assert.equal(calls.length, 1);
  assert.equal(b.verdict.item_type, 'bag');
  assert.equal(b.cached, true);
  assert.equal(a.cached, false);
  store.close();
});

test('estimateCost prices usage from a per-million table', () => {
  const c = estimateCost({ promptTokens: 1_000_000, completionTokens: 1_000_000 }, { prompt: 0.15, completion: 0.47 });
  assert.equal(c, 0.62);
});

test('a schema echoed back triggers a json_object retry; normalizeVerdict repairs loose fields', async () => {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const content = n++ === 0 ? JSON.stringify([VERDICT_SCHEMA]) : JSON.stringify({ item_type: 'handbag', authenticity_risk: 'LOW?', red_flags: 'price too low', confidence: '0.7', resale_estimate_eur: { low: '100', high: '150' } });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: {} }) };
  };
  const client = createVisionClient({ apiKey: 'k', fetchImpl });
  const out = await client.analyze(listing);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].response_format.type, 'json_object');
  assert.equal(out.verdict.item_type, 'bag'); // 'handbag' → bag
  assert.equal(out.verdict.authenticity_risk, 'medium');
  assert.deepEqual(out.verdict.red_flags, ['price too low']);
  assert.equal(out.verdict.confidence, 0.7);
  assert.deepEqual(out.verdict.resale_estimate_eur, { low: 100, high: 150 });
  assert.equal(normalizeVerdict({ properties: {} }), undefined);
});

test('triage screens listings by text in batches and returns picks by id', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { const body = JSON.parse(init.body); calls.push(body); const ids = body.messages[1].content.split('\n').slice(1).map((l) => Number(l.split(' | ')[0])); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ picks: ids.map((id, i) => ({ id, worth_checking: i % 2 === 0, est_resale_eur: 500, reason: 'x' })) }) } }], usage: {} }) }; };
  const client = createVisionClient({ apiKey: 'k', fetchImpl });
  const listings = Array.from({ length: 45 }, (_, i) => ({ id: i + 1, brand: 'Prada', title: 'bag ' + i, price: 100 }));
  const picks = await client.triage(listings, { batchSize: 40 });
  assert.equal(calls.length, 2);
  assert.equal(picks.size, 45);
  assert.equal(picks.get(1).worth_checking, true);
  assert.equal(picks.get(2).worth_checking, false);
  assert.equal(picks.get(1).est_resale_eur, 500);
  assert.equal(calls[0].messages[1].content.split('\n').length, 41);
});

test('normalizeVerdict maps loose item types and condition labels to the canonical sets', () => {
  assert.equal(normalizeVerdict({ item_type: 'boots', authenticity_risk: 'Low', condition_grade: 'Good' }).item_type, 'shoes');
  assert.equal(normalizeVerdict({ item_type: 'Handbag', authenticity_risk: 'low', condition_grade: 'very good' }).item_type, 'bag');
  assert.equal(normalizeVerdict({ item_type: 'wool cardigan', authenticity_risk: 'low' }).item_type, 'knitwear');
  assert.equal(normalizeVerdict({ item_type: 'sunglasses', authenticity_risk: 'low' }).item_type, 'accessory');
  const n = normalizeVerdict({ item_type: 'boots', authenticity_risk: 'Low', condition_grade: 'Like New' });
  assert.equal(n.condition_grade, 'excellent');
  assert.equal(n.authenticity_risk, 'low');
});
