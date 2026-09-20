import { findObjectAfterKey, unwrapHtmlFlight, isSessionRefreshPage, looksBlocked } from './flight.js';
import { conditionIdFromText, resolveOrder } from './lookup.js';
import { num, absUrl, VintedError } from './util.js';

const ITEMS_MARKER = '"items":{"items":[';

/**
 * Search parameters understood by {@link buildCatalogUrl}. Ids are Vinted's own; use the
 * scraper's `resolve*` helpers (or the `brands`/`catalogs` commands) to turn names into ids.
 * @typedef {object} SearchParams
 * @property {string} [query]
 * @property {number} [page]
 * @property {string} [order] newest | relevance | price_asc | price_desc (or raw Vinted values)
 * @property {number} [priceFrom]
 * @property {number} [priceTo]
 * @property {number[]} [brandIds]
 * @property {number[]} [catalogIds]
 * @property {number[]} [sizeIds]
 * @property {number[]} [statusIds] condition ids, see CONDITIONS
 * @property {number[]} [colorIds]
 * @property {number[]} [materialIds]
 * @property {string} [currency]
 */

const LIST_PARAMS = [
  ['brandIds', 'brand_ids[]'],
  ['catalogIds', 'catalog[]'],
  ['sizeIds', 'size_ids[]'],
  ['statusIds', 'status_ids[]'],
  ['colorIds', 'color_ids[]'],
  ['materialIds', 'material_ids[]'],
];

export function buildCatalogUrl(baseUrl, params = {}) {
  const url = new URL('/catalog', baseUrl);
  const sp = url.searchParams;
  if (params.query) sp.set('search_text', params.query);
  const order = resolveOrder(params.order);
  if (order) sp.set('order', order);
  if (params.priceFrom !== undefined && params.priceFrom !== null) sp.set('price_from', String(params.priceFrom));
  if (params.priceTo !== undefined && params.priceTo !== null) sp.set('price_to', String(params.priceTo));
  if (params.currency) sp.set('currency', params.currency);
  for (const [key, name] of LIST_PARAMS) {
    for (const v of params[key] ?? []) if (v !== undefined && v !== null && v !== '') sp.append(name, String(v));
  }
  if (params.page && params.page > 1) sp.set('page', String(params.page));
  return url.toString();
}

/** Parses a catalog page payload (flight text or full HTML) into raw items + pagination. */
export function parseCatalogFlight(text) {
  if (isSessionRefreshPage(text)) {
    throw new VintedError('Vinted returned its "Session refresh" page instead of results; the session cookies are stale.', { code: 'SESSION_REFRESH' });
  }
  const flight = unwrapHtmlFlight(text);
  const store = findObjectAfterKey(flight, ITEMS_MARKER);
  if (!store || !Array.isArray(store.items)) {
    if (looksBlocked(text)) throw new VintedError('Request was challenged by Vinted\'s bot protection (DataDome).', { code: 'BLOCKED' });
    throw new VintedError('Could not find the catalog items store in the page payload (page layout may have changed).', { code: 'PARSE' });
  }
  const p = store.pagination ?? {};
  return {
    items: store.items,
    pagination: {
      currentPage: p.current_page ?? 1,
      perPage: p.per_page ?? store.items.length,
      totalPages: p.total_pages ?? 1,
      totalEntries: p.total_entries ?? store.items.length,
      time: p.time,
    },
    tracking: store.searchTrackingParams,
  };
}

/**
 * Item cards render a second line like "S / 36 / 8 · Veoma dobro" (size · condition). Either
 * part may be missing, so a lone value is classified by checking it against known condition labels.
 */
export function splitItemBox(secondLine) {
  const text = String(secondLine ?? '').trim();
  if (!text) return { size: undefined, condition: undefined, conditionId: undefined };
  const parts = text.split(/\s+[·•]\s+/);
  if (parts.length >= 2) {
    const condition = parts[parts.length - 1].trim();
    const size = parts.slice(0, -1).join(' · ').trim();
    return { size, condition, conditionId: conditionIdFromText(condition) };
  }
  const conditionId = conditionIdFromText(text);
  if (conditionId) return { size: undefined, condition: text, conditionId };
  return { size: text, condition: undefined, conditionId: undefined };
}

/** Converts a raw catalog entry into a flat, typed listing object. */
export function normalizeItem(raw, baseUrl) {
  const p = raw.productItem ?? raw;
  const box = p.itemBox ?? {};
  const { size, condition, conditionId } = splitItemBox(box.secondLine);
  const photos = (p.photos ?? []).map((ph) => ph.url).filter(Boolean);
  return {
    id: Number(p.id ?? raw.id),
    title: p.title,
    url: absUrl(baseUrl, p.url),
    price: num(p.price?.amount),
    currency: p.price?.currencyCode,
    priceWithDiscount: num(p.priceWithDiscount?.amount),
    serviceFee: num(p.serviceFee?.amount),
    totalPrice: num(p.totalItemPrice?.amount),
    brand: box.firstLine || undefined,
    size,
    condition,
    conditionId,
    favouriteCount: p.favouriteCount ?? 0,
    isPromoted: Boolean(p.isPromoted),
    thumbnail: p.thumbnailUrl,
    photos,
    dominantColor: p.dominantColor,
    sellerId: p.user?.id,
    sellerIsBusiness: Boolean(p.user?.isBusiness),
    accessibilityLabel: box.accessibilityLabel,
    searchScore: num(raw.catalogTracking?.searchScore),
    contentSource: raw.catalogTracking?.contentSource,
  };
}
