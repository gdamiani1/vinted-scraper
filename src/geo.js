import { normalizeText, sleep, VintedError } from './util.js';

const EARTH_RADIUS_KM = 6371.0088;

export function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** "48.2,16.37" → coordinates; anything else → a place query for the geocoder. */
export function parseNear(input) {
  const m = String(input ?? '').trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (m) return { lat: Number(m[1]), lon: Number(m[2]) };
  return { query: String(input).trim() };
}

/**
 * Place-name → coordinates via OpenStreetMap's Nominatim, with results (including misses) cached
 * in the Store. Nominatim's usage policy: at most 1 request/second and an identifying User-Agent.
 */
export class Geocoder {
  constructor({ store, fetchImpl = globalThis.fetch, minDelayMs = 1100, userAgent, email = process.env.NOMINATIM_EMAIL, logger } = {}) {
    this.store = store;
    this.fetch = fetchImpl;
    this.minDelayMs = minDelayMs;
    this.userAgent = userAgent ?? `vinted-scraper/1.0 (local research tool${email ? `; ${email}` : ''})`;
    this.email = email;
    this.logger = logger;
    this.lastAt = 0;
  }

  async geocode(place, countryCode) {
    const cc = countryCode ? String(countryCode).toLowerCase() : '';
    const key = `${cc}|${normalizeText(place)}`;
    if (!normalizeText(place)) return null;
    const cached = this.store?.getGeocode(key);
    if (cached !== undefined) return cached;
    const wait = this.lastAt + this.minDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastAt = Date.now();
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', place);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('addressdetails', '1');
    if (cc) url.searchParams.set('countrycodes', cc);
    if (this.email) url.searchParams.set('email', this.email);
    const res = await this.fetch(url, { headers: { 'user-agent': this.userAgent, accept: 'application/json' } });
    if (!res.ok) throw new VintedError(`Geocoder responded ${res.status} for ${JSON.stringify(place)}`, { code: 'GEOCODE', status: res.status });
    const [hit] = await res.json();
    const result = hit
      ? { lat: Number(hit.lat), lon: Number(hit.lon), name: hit.display_name, countryCode: hit.address?.country_code?.toUpperCase() }
      : null;
    this.store?.putGeocode(key, result);
    this.logger?.debug(`geocode ${JSON.stringify(place)} → ${result ? `${result.lat},${result.lon}` : 'miss'}`);
    return result;
  }
}

/** Turns `--near` input plus radius into a resolved reference point. */
/** A country-only filter: same shape as a resolved `near`, no distance involved. */
export function countryFilter(code, { strict = false } = {}) {
  return { countryCode: String(code).toUpperCase(), radiusKm: Infinity, name: String(code).toUpperCase(), strict, countryOnly: true };
}

export async function resolveNear(input, { geocoder, radiusKm = 50, strict = false, countryCode } = {}) {
  const parsed = parseNear(input);
  let point;
  if (parsed.query) {
    point = await geocoder.geocode(parsed.query, countryCode);
    if (!point) throw new VintedError(`Could not geocode ${JSON.stringify(parsed.query)}`, { code: 'BAD_INPUT' });
  } else {
    point = { ...parsed, name: input, countryCode };
  }
  return { lat: point.lat, lon: point.lon, name: point.name ?? input, countryCode: (countryCode ?? point.countryCode)?.toUpperCase(), radiusKm, strict };
}

/**
 * Looks up each listing's seller (cached in the Store), geocodes the seller's city, and keeps
 * listings within `near.radiusKm`. Sellers in the right country who hide their city are kept
 * with `location.status = "unknown"` unless `near.strict` is set. Each kept item gets a
 * `location` object; dropped items are returned separately when `returnDropped` is set.
 */
export async function locateItems(items, { scraper, store, geocoder, near, returnDropped = false, sellerMaxAgeMs } = {}) {
  const sellerIds = [...new Set(items.map((i) => i.sellerId).filter(Boolean))];
  const profiles = new Map();
  for (const id of sellerIds) {
    let p = store?.getSeller(id, { maxAgeMs: sellerMaxAgeMs });
    if (!p) {
      try {
        p = await scraper.user(id);
        store?.putSeller(p);
      } catch (e) {
        scraper.logger?.warn(`seller ${id}: ${e.message}`);
        p = { id, error: e.message };
      }
    }
    profiles.set(id, p);
  }
  const kept = [];
  const dropped = [];
  for (const item of items) {
    const p = profiles.get(item.sellerId) ?? {};
    const loc = { countryCode: p.countryCode, city: p.city || undefined, sellerLogin: p.login, status: 'unknown' };
    if (p.error) loc.status = 'unknown';
    else if (near.countryCode && p.countryCode && p.countryCode !== near.countryCode) loc.status = 'other_country';
    else if (near.countryOnly) loc.status = p.countryCode ? 'within' : 'unknown';
    else if (loc.city) {
      const pt = await geocoder.geocode(loc.city, p.countryCode);
      if (pt) {
        loc.distanceKm = Math.round(haversineKm(near, pt) * 10) / 10;
        loc.status = loc.distanceKm <= near.radiusKm ? 'within' : 'outside';
      }
    }
    const keep = loc.status === 'within' || (loc.status === 'unknown' && !near.strict && (!near.countryCode || !p.countryCode || p.countryCode === near.countryCode));
    (keep ? kept : dropped).push({ ...item, location: loc });
  }
  return returnDropped ? { kept, dropped } : kept;
}

export function formatLocation(loc) {
  if (!loc) return '';
  if (loc.status === 'within' && loc.distanceKm === undefined) return `${loc.countryCode}${loc.city ? ` · ${loc.city}` : ''}`;
  if (loc.status === 'within' || loc.status === 'outside') return `${loc.city} (${loc.distanceKm} km)`;
  if (loc.status === 'unknown') return `${loc.countryCode ?? '?'}, city hidden`;
  return `${loc.countryCode ?? '?'}${loc.city ? ` ${loc.city}` : ''}`;
}
