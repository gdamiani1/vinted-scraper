import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, toNdjson, formatTable } from '../src/export.js';

test('toCsv escapes quotes, commas and newlines and flattens nested objects', () => {
  const csv = toCsv([{ id: 1, title: 'He said "hi", ok\nnew', seller: { id: 5 }, photos: ['a', 'b'] }]);
  const [header, row] = csv.split('\r\n');
  assert.equal(header, 'id,title,seller.id,photos');
  assert.equal(row, '1,"He said ""hi"", ok\nnew",5,a|b');
});

test('toNdjson emits one JSON object per line', () => {
  assert.equal(toNdjson([{ a: 1 }, { b: 2 }]), '{"a":1}\n{"b":2}\n');
});

test('formatTable renders aligned columns', () => {
  const out = formatTable([{ id: 1, price: 9.5, title: 'Short' }, { id: 22, price: 100, title: 'Longer title' }], ['id', 'price', 'title']);
  const lines = out.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^id\s+price\s+title$/);
  assert.match(lines[2], /^22\s+100\s+Longer title$/);
});

test('sendTelegram posts HTML-formatted deal lines to the Bot API', async () => {
  const { sendTelegram } = await import('../src/notify.js');
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => '' }; };
  await sendTelegram({ token: 'T', chatId: '42' }, { type: 'new', search: 'am90', items: [{ id: 1, title: 'Nike <Air> Max', url: 'https://x/items/1', price: 12, currency: 'EUR', size: '42', deal: { score: 70 } }] }, { fetchImpl });
  assert.equal(calls[0].url, 'https://api.telegram.org/botT/sendMessage');
  assert.equal(calls[0].body.chat_id, '42');
  assert.equal(calls[0].body.parse_mode, 'HTML');
  assert.match(calls[0].body.text, /Nike &lt;Air&gt; Max/);
  assert.match(calls[0].body.text, /score 70/);
});
