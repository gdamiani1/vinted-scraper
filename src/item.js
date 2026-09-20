import { findObjects, findObjectAfterKey, unwrapHtmlFlight, isSessionRefreshPage, looksBlocked } from './flight.js';
import { num, absUrl, VintedError } from './util.js';
import { conditionIdFromText } from './lookup.js';

export function parseItemId(input) {
  if (typeof input === 'number' && Number.isInteger(input) && input > 0) return input;
  const s = String(input ?? '').trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/\/items\/(\d+)/);
  if (m) return Number(m[1]);
  throw new VintedError(`Cannot parse item id from ${JSON.stringify(input)}`, { code: 'BAD_INPUT' });
}

const isPlugin = (o) => typeof o.name === 'string' && typeof o.section === 'string' && o.data && typeof o.data === 'object';

function pluginMap(flight) {
  const map = new Map();
  for (const p of findObjects(flight, '{"data":', isPlugin)) {
    const existing = map.get(p.name);
    // The sidebar copy is the canonical one when a plugin appears in several sections.
    if (!existing || (p.section === 'sidebar' && existing.section !== 'sidebar')) map.set(p.name, p);
  }
  return map;
}

function money(m) {
  if (!m) return {};
  return { amount: num(m.amount), currency: m.currencyCode ?? m.currency_code };
}

/** Parses an item page payload (flight text or full HTML) into a detailed item record. */
export function parseItemFlight(text, baseUrl) {
  if (isSessionRefreshPage(text)) throw new VintedError('Vinted returned its "Session refresh" page.', { code: 'SESSION_REFRESH' });
  const flight = unwrapHtmlFlight(text);
  const plugins = pluginMap(flight);
  const sidebar = findObjectAfterKey(flight, '"item":{"brand_dto"');
  if (!plugins.size && !sidebar) {
    if (looksBlocked(text)) throw new VintedError('Request was challenged by Vinted\'s bot protection (DataDome).', { code: 'BLOCKED' });
    throw new VintedError('Could not find item data in the page payload (item may be removed, or the layout changed).', { code: 'PARSE' });
  }
  const get = (name) => plugins.get(name)?.data;
  const attrs = get('attributes')?.attributes ?? [];
  const attr = (code) => attrs.find((a) => a.code === code)?.data;
  const offer = get('make_offer') ?? {};
  const buy = get('buy') ?? get('ask_seller') ?? {};
  const ask = get('ask_seller') ?? {};
  const seller = get('user_info_header') ?? {};
  const badges = get('seller_badges_info')?.badges?.map((b) => b.type) ?? [];
  const crumbs = get('breadcrumbs') ?? {};
  const pricing = findObjectAfterKey(flight, '"pricingServices":') ?? {};
  const services = pricing.services ?? {};
  const shippingDetails = findObjectAfterKey(flight, '"shippingDetails":') ?? {};
  const canonical = flight.match(/"rel":"canonical","href":"([^"]+)"/)?.[1];

  const id = Number(offer.item_id ?? sidebar?.id ?? seller.item_id ?? get('description')?.item_id ?? crumbs.item_id);
  const summaryTitle = get('summary')?.lines?.[0]?.elements?.[0]?.value;
  const title = offer.title ?? sidebar?.title ?? summaryTitle ?? flight.match(/"title","0",\{"children":"(.*?) \| Vinted"\}/)?.[1];
  const brandAttr = attr('brand');
  const brand = brandAttr
    ? { id: num(brandAttr.id), title: brandAttr.value }
    : sidebar?.brand_dto
      ? { id: num(sidebar.brand_dto.id), title: sidebar.brand_dto.title }
      : undefined;
  const sizeAttr = attr('size');
  const statusAttr = attr('status');
  const price = money(offer.price ?? sidebar?.price);
  const total = money(pricing.totalAmount);
  const asking = money(pricing.originalAskingAmount);
  const bp = money(services.buyerProtection?.finalPrice);
  const shipSvc = services.shipping;
  const shipping = shipSvc
    ? { ...pick(money(shipSvc.finalPrice), 'price'), isFree: Boolean(shipSvc.isFree), pickupOnly: Boolean(services.isPickUpOnly), multipleOptions: Boolean(shipSvc.areMultipleShippingOptionsAvailable) }
    : shippingDetails.price
      ? { ...pick(money(shippingDetails.price), 'price'), isFree: Boolean(shippingDetails.isFreeShipping), pickupOnly: Boolean(shippingDetails.isPickupOnly), multipleOptions: Boolean(shippingDetails.areMultipleShippingOptionsAvailable) }
      : undefined;
  const photos = (offer.photos ?? []).map((p) => p.url).filter(Boolean);
  const sellerId = num(seller.seller_id ?? offer.seller_id ?? sidebar?.seller_id);

  return {
    id,
    title,
    url: canonical ?? absUrl(baseUrl, `/items/${id}`),
    description: get('description')?.description,
    brand,
    catalogId: num(crumbs.catalog_id ?? sidebar?.catalog_id),
    breadcrumbs: crumbs.breadcrumbs?.map((b) => b.title),
    size: sizeAttr ? { id: num(sizeAttr.id), value: sizeAttr.value } : undefined,
    condition: statusAttr?.value,
    conditionId: conditionIdFromText(statusAttr?.value),
    color: attr('color')?.value,
    material: attr('material')?.value,
    uploadedAgo: attr('upload_date')?.value,
    attributes: attrs.map((a) => ({ code: a.code, title: a.data?.title, value: a.data?.value, id: num(a.data?.id) })),
    price: price.amount,
    currency: price.currency,
    priceConverted: asking.amount,
    priceConvertedCurrency: asking.currency,
    buyerPrice: total.amount,
    buyerCurrency: total.currency,
    buyerProtectionFee: bp.amount,
    shipping,
    photos,
    seller: sellerId
      ? {
          id: sellerId,
          name: seller.name ?? get('seller_badges_info')?.username,
          feedbackCount: seller.feedback_count,
          feedbackReputation: seller.feedback_reputation,
          business: Boolean(seller.business ?? sidebar?.business),
          badges,
          lastActive: seller.user_info?.find((u) => u.key === 'last-logged-in')?.text,
          url: absUrl(baseUrl, `/member/${sellerId}`),
        }
      : undefined,
    flags: {
      canBuy: Boolean(ask.can_buy ?? sidebar?.can_buy),
      isReserved: Boolean(ask.is_reserved ?? buy.is_reserved ?? sidebar?.is_reserved),
      isHidden: Boolean(ask.is_hidden ?? sidebar?.is_hidden),
      instantBuy: Boolean(ask.instant_buy ?? sidebar?.instant_buy),
    },
  };
}

function pick(m, key) {
  return { [key]: m.amount, currency: m.currency };
}
