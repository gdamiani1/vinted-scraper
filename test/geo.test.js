import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, Geocoder, locateItems, parseNear } from '../src/geo.js';
import { Store } from '../src/store.js';

test('haversineKm computes great-circle distance', () => {
  const vienna = { lat: 48.2082, lon: 16.3738 };
  const klosterneuburg = { lat: 48.3053, lon: 16.3253 };
  const graz = { lat: 47.0707, lon: 15.4395 };
  assert.ok(Math.abs(haversineKm(vienna, klosterneuburg) - 11.3) < 1);
  assert.ok(Math.abs(haversineKm(vienna, graz) - 145) < 5);
  assert.equal(haversineKm(vienna, vienna), 0);
});

test('parseNear accepts "lat,lon" and place names', () => {
  assert.deepEqual(parseNear('48.2,16.37'), { lat: 48.2, lon: 16.37 });
  assert.deepEqual(parseNear('Wien'), { query: 'Wien' });
});

test('Geocoder caches lookups in the store and only calls the network once per place', async () => {
  const store = new Store(':memory:');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => [{ lat: '48.2082', lon: '16.3738', display_name: 'Wien, Österreich', address: { country_code: 'at' } }] };
  };
  const geo = new Geocoder({ store, fetchImpl, minDelayMs: 0 });
  const a = await geo.geocode('Wien', 'AT');
  const b = await geo.geocode('wien ', 'at');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /nominatim\.openstreetmap\.org\/search/);
  assert.match(calls[0], /countrycodes=at/);
  assert.deepEqual(a, { lat: 48.2082, lon: 16.3738, name: 'Wien, Österreich', countryCode: 'AT' });
  assert.deepEqual(b, a);
  store.close();
});

test('Geocoder caches misses too', async () => {
  const store = new Store(':memory:');
  let n = 0;
  const geo = new Geocoder({ store, fetchImpl: async () => { n++; return { ok: true, status: 200, json: async () => [] }; }, minDelayMs: 0 });
  assert.equal(await geo.geocode('Nowhereville', 'AT'), null);
  assert.equal(await geo.geocode('Nowhereville', 'AT'), null);
  assert.equal(n, 1);
  store.close();
});

test('locateItems annotates listings with seller distance and filters by radius', async () => {
  const store = new Store(':memory:');
  const profiles = {
    1: { id: 1, login: 'a', countryCode: 'AT', city: 'Klosterneuburg' },
    2: { id: 2, login: 'b', countryCode: 'AT', city: 'Graz' },
    3: { id: 3, login: 'c', countryCode: 'AT', city: undefined },
    4: { id: 4, login: 'd', countryCode: 'DE', city: 'Berlin' },
  };
  let userCalls = 0;
  const scraper = { user: async (id) => { userCalls++; return profiles[id]; }, logger: { debug() {}, warn() {}, info() {} } };
  const coords = { 'klosterneuburg': [48.3053, 16.3253], 'graz': [47.0707, 15.4395], 'berlin': [52.52, 13.405] };
  const geocoder = { geocode: async (city) => { const c = coords[city.toLowerCase()]; return c ? { lat: c[0], lon: c[1], name: city, countryCode: 'XX' } : null; } };
  const items = [1, 2, 3, 4].map((sellerId) => ({ id: sellerId * 10, sellerId, title: `t${sellerId}` }));
  const near = { lat: 48.2082, lon: 16.3738, countryCode: 'AT', radiusKm: 50 };

  const kept = await locateItems(items, { scraper, store, geocoder, near });
  assert.deepEqual(kept.map((i) => i.id), [10, 30]);
  assert.equal(kept[0].location.status, 'within');
  assert.ok(kept[0].location.distanceKm > 10 && kept[0].location.distanceKm < 13);
  assert.equal(kept[0].location.city, 'Klosterneuburg');
  assert.equal(kept[1].location.status, 'unknown');
  assert.equal(kept[1].location.countryCode, 'AT');

  const strict = await locateItems(items, { scraper, store, geocoder, near: { ...near, strict: true } });
  assert.deepEqual(strict.map((i) => i.id), [10]);
  // seller profiles were cached: second pass made no new user calls
  assert.equal(userCalls, 4);
  store.close();
});

test('Store caches seller profiles with a TTL', () => {
  const store = new Store(':memory:');
  assert.equal(store.getSeller(5), undefined);
  store.putSeller({ id: 5, login: 'x', countryCode: 'AT', city: 'Wien' });
  assert.equal(store.getSeller(5).city, 'Wien');
  assert.equal(store.getSeller(5, { maxAgeMs: -1 }), undefined);
  store.close();
});
