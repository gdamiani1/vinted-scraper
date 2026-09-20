import { readFileSync } from 'node:fs';
import { normalizeText, num } from './util.js';
import { median } from './deals.js';

const DEFAULT_PATH = new URL('./rules.default.json', import.meta.url);

/** Loads resale rules: the bundled defaults, optionally overlaid with a user file. */
export function loadRules(path) {
  const base = JSON.parse(readFileSync(DEFAULT_PATH, 'utf8'));
  if (!path) return base;
  const user = JSON.parse(readFileSync(path, 'utf8'));
  return deepMerge(base, user);
}

function deepMerge(a, b) {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== 'object' || typeof b !== 'object' || !a || !b) return b ?? a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a[k], v);
  return out;
}

export function brandTier(brand, rules) {
  const b = normalizeText(brand);
  if (!b) return 'other';
  for (const tier of ['tier1', 'tier2', 'tier3']) {
    for (const name of rules.brands[tier] ?? []) {
      const n = normalizeText(name);
      if (n.endsWith(' x') ? b.startsWith(n) : b === n || b.startsWith(n + ' ')) return tier;
    }
  }
  return 'other';
}

/** "S / 36 / 8" → { letter: 'S', eu: 36 }; "42,5" → { eu: 42.5 }; "XXXL" → { letter: 'XXXL' }. */
export function parseSize(size) {
  const s = String(size ?? '').toUpperCase().replace(',', '.').trim();
  if (!s) return { letter: undefined, eu: undefined };
  const parts = s.split(/\s*\/\s*/);
  const letter = parts.map((p) => p.trim()).find((p) => /^(XXS|XS|S|M|L|XL|XXL|XXXL|[3-9]XL)$/.test(p));
  const eu = parts.map((p) => num(p.match(/^(\d{2}(?:\.5)?)$/)?.[1])).find((n) => n !== undefined && n >= 30 && n <= 60);
  return { letter, eu };
}

function stepLookup(table, value) {
  let best;
  for (const [threshold, weight] of table) {
    if (value >= threshold) best = weight;
  }
  return best ?? table[0][1];
}

/** 0-1 weight for how easily this size resells in this category. Unsized categories return 1. */
export function sizeDesirability(size, itemType, rules) {
  if (!rules.sizedCategories.includes(itemType)) return 1;
  const table = itemType === 'shoes' ? rules.sizes.shoes : rules.sizes.clothing;
  const { letter, eu } = parseSize(size);
  if (eu !== undefined && table.eu) return stepLookup(table.eu, eu);
  if (letter && table.letters?.[letter] !== undefined) return table.letters[letter];
  return table.unknown ?? 0.6;
}

/** Price floor below which a listing of this brand tier is treated as packaging/placeholder noise. */
export function priceFloor(tier, rules) {
  return rules.priceFloorByTier?.[tier] ?? rules.luxuryPriceFloorEur ?? 0;
}

export function categoryLiquidity(itemType, rules) {
  return rules.categories[itemType] ?? rules.categories.other;
}

const RISK_WEIGHT = { low: 1, medium: 0.45, high: 0 };

/** "vor 8 Monaten", "prije 2 min", "7 h", "3 days ago", "il y a 2 semaines" → age in days (undefined if unparseable). */
export function listingAgeDays(text) {
  const s = normalizeText(text);
  if (!s) return undefined;
  const m = s.match(/(\d+)\s*(min|minut|h\b|hour|stund|sat|ur|tag|day|dan|jour|giorn|dia|dzie|dni|week|woche|tjed|semain|settiman|seman|tydz|month|monat|mjesec|mois|mes|mies|year|jahr|godin|an\b|ann|rok|lat)/);
  if (!m) return /(gerade|just now|upravo|maintenant|adesso|ahora)/.test(s) ? 0 : undefined;
  const n = Number(m[1]);
  const u = m[2];
  if (/^(min|minut)/.test(u)) return n / 1440;
  if (/^(h|hour|stund|sat|ur)/.test(u)) return n / 24;
  if (/^(tag|day|dan|jour|giorn|dia|dzie|dni)/.test(u)) return n;
  if (/^(week|woche|tjed|semain|settiman|seman|tydz)/.test(u)) return n * 7;
  if (/^(month|monat|mjesec|mois|mes|mies)/.test(u)) return n * 30;
  return n * 365;
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Explainable buy score for resale (0-100).
 *
 * resaleEstimate = vision estimate (midpoint) or median of comparables, scaled by condition.
 * margin         = resaleEstimate × (1 - sellFee) - all-in cost (buyer price incl. protection/shipping).
 * sellability    = brand tier × category liquidity × size desirability.
 * confidence     = authenticity risk weight × (0.5 + 0.5 × verdict confidence); no verdict → 0.5.
 * score          = 100 × marginQuality × sellability × confidence, with hard zeroes for high
 *                  authenticity risk and for prices under the floor.
 */
export function buyScore(item, { verdict, rules, comparables = [], sellFeePct = rules.sellFeePct } = {}) {
  const reasons = [];
  const itemType = verdict?.item_type ?? 'other';
  const tier = brandTier(verdict?.brand_seen ?? item.brand, rules);
  const price = num(item.price);
  // All-in cost: buyer price (item + buyer protection) plus shipping when the item page told us the rate.
  const shipping = num(item.detail?.shipping?.price) ?? num(item.shipping?.price) ?? 0;
  const cost = (num(item.detail?.buyerPrice ?? item.buyerPrice ?? item.totalPrice ?? item.price) ?? price ?? 0) + shipping;

  const conditionKey = verdict?.condition_grade ?? ({ 6: 'new', 1: 'new', 2: 'very_good', 3: 'good', 4: 'fair' }[item.conditionId] ?? 'good');
  const condMult = rules.conditionMultiplier[conditionKey] ?? 0.7;
  let resaleEstimate;
  let source;
  if (verdict?.resale_estimate_eur && Number.isFinite(verdict.resale_estimate_eur.low) && Number.isFinite(verdict.resale_estimate_eur.high)) {
    // The model is asked for a range "in this condition", so no further condition discount.
    resaleEstimate = Math.round((verdict.resale_estimate_eur.low + verdict.resale_estimate_eur.high) / 2);
    source = 'vision estimate';
  } else if (comparables.length >= 3) {
    // Comparables are asking prices across mixed conditions; scale by this item's condition.
    resaleEstimate = Math.round(median(comparables) * condMult / 0.85);
    source = `${comparables.length} comparables`;
  }

  let marginQuality = 0.35; // unknown resale value: neutral-low
  let margin;
  if (resaleEstimate !== undefined && cost !== undefined) {
    margin = Math.round(resaleEstimate * (1 - sellFeePct) - cost);
    const marginPct = cost > 0 ? margin / cost : 0;
    marginQuality = clamp(marginPct / (rules.targetMarginPct * 1.25), 0, 1); // full marks at 1.25× target margin
    reasons.push(`${margin >= 0 ? '+' : ''}${margin} ${item.currency ?? 'EUR'} margin (${Math.round(marginPct * 100)}%) vs ${resaleEstimate} resale from ${source}${shipping ? `, incl. ${shipping} shipping` : ''}`);
  } else {
    reasons.push('No resale estimate yet');
  }

  const brandW = rules.brandWeight[tier];
  const catW = categoryLiquidity(itemType, rules);
  const sizeW = sizeDesirability(item.size, itemType, rules);
  const sellability = brandW * catW * sizeW;
  reasons.push(`${tier === 'other' ? 'Non-luxury brand' : `${tier} brand`}, ${itemType.replace(/_/g, ' ')} liquidity ${catW}`);
  if (sizeW < 0.5 && rules.sizedCategories.includes(itemType)) reasons.push(`Size ${item.size ?? 'unknown'} is hard to resell (weight ${sizeW})`);

  const risk = verdict?.authenticity_risk ?? 'medium';
  const riskW = RISK_WEIGHT[risk] ?? 0.45;
  const confidence = verdict ? riskW * (0.5 + 0.5 * clamp(verdict.confidence ?? 0.6, 0, 1)) : 0.5;
  if (verdict) reasons.push(`Authenticity risk ${risk}${verdict.authenticity_observations?.length ? `: ${verdict.authenticity_observations.slice(0, 2).join('; ')}` : ''}`);
  if (verdict?.red_flags?.length) reasons.push(`Red flags: ${verdict.red_flags.slice(0, 3).join('; ')}`);
  if (verdict?.photo_quality === 'stock_images') reasons.push('Stock images only');

  let score = 100 * marginQuality * sellability * confidence;
  // A bargain that has sat unsold for months is not a bargain: the market has already passed on it.
  const age = listingAgeDays(item.detail?.uploadedAgo ?? item.uploadedAgo);
  if (age !== undefined && age > 90) { score *= 0.4; reasons.push(`Listed ~${Math.round(age / 30)} months ago and still unsold`); }
  else if (age !== undefined && age > 30) { score *= 0.65; reasons.push(`Listed ~${Math.round(age / 7)} weeks ago and still unsold`); }
  // Sellers with no history are where counterfeits and scams cluster.
  const fb = item.detail?.seller?.feedbackCount;
  if (fb !== undefined && fb < 3) { score *= 0.6; reasons.push(`Seller has ${fb} reviews`); }
  else if (fb !== undefined && fb < 10) { score *= 0.85; reasons.push(`Seller has only ${fb} reviews`); }
  if (risk === 'high') score = 0;
  if (price !== undefined && price < Math.min(rules.priceFloorEur ?? 15, priceFloor(tier, rules))) { score = 0; reasons.push(`Price ${price} below floor (placeholder?)`); }
  if (verdict?.photo_quality === 'stock_images') score *= 0.5;

  return {
    score: Math.round(clamp(score, 0, 100)),
    margin,
    resaleEstimate,
    costAllIn: cost,
    sellability: Number(sellability.toFixed(2)),
    confidence: Number(confidence.toFixed(2)),
    tier,
    itemType,
    reasons,
  };
}

/**
 * Does this listing fit the sizes in rules.mySizes? Vinted size strings vary by category and
 * language ("L / 40 / 12", "45", "45,5", "29.5 cm", "W34 L34", "34/34", "50"). Unknown sizes are
 * never a fit. `itemType` (from a verdict) disambiguates numbers when available.
 */
const WOMEN_ROOTS = ['zene', 'damen', 'women', 'femmes', 'femme', 'donna', 'mujer', 'kobiety', 'dames', 'mulher', 'zeny', 'moterys', 'nok', 'femei', 'dam', 'kvinder', 'naiset', 'γυναικες', 'sievietes', 'naised', 'women_root'];
const MEN_ROOTS = ['muskarci', 'herren', 'men', 'hommes', 'homme', 'uomo', 'hombre', 'mezczyzni', 'heren', 'homem', 'muzi', 'vyrai', 'ferfiak', 'barbati', 'herr', 'maend', 'miehet', 'ανδρες', 'viriesi', 'mehed', 'men_root'];
const KIDS_ROOTS = ['djeca', 'kinder', 'kids', 'enfants', 'bambini', 'ninos', 'dzieci', 'kinderen', 'crianca', 'deti', 'vaikai', 'gyerekek', 'copii', 'barn', 'born', 'lapset', 'παιδια', 'berni', 'lapsed'];
const WOMEN_WORDS = /\b(damen|femme|femmes|donna|mujer|women'?s?|ladies|lady|zenske|zenska|zensk[aeio]|damskie|damska|dames|senhora|damske|womens|girls?|w\d{2}\b)/;
const MEN_WORDS = /\b(herren|homme|hommes|uomo|hombre|men'?s?|mens|gents?|muske|muski|musk[aeio]|meskie|meska|heren|homem|panske|herr|maend|mænd|boys?)\b/;

/** men | women | kids | unisex | unknown, from verdict, category breadcrumbs, then title/description words. */
export function genderOf(item) {
  const g = item.verdict?.gender;
  if (g && ['men', 'women', 'kids', 'unisex'].includes(g)) return g;
  const root = normalizeText(item.detail?.breadcrumbs?.[0] ?? '');
  if (root) {
    if (WOMEN_ROOTS.includes(root)) return 'women';
    if (MEN_ROOTS.includes(root)) return 'men';
    if (KIDS_ROOTS.includes(root)) return 'kids';
  }
  const hay = normalizeText(`${item.title ?? ''} ${item.detail?.description ?? ''}`);
  const w = WOMEN_WORDS.test(hay);
  const m = MEN_WORDS.test(hay);
  if (w && !m) return 'women';
  if (m && !w) return 'men';
  if (m && w) return 'unisex';
  return 'unknown';
}

export function fitsMySize(item, rules, itemType) {
  const my = rules.mySizes;
  if (!my) return true;
  if (my.gender === 'men') {
    const g = genderOf(item);
    if (g === 'women' || g === 'kids') return false;
  }
  const type = itemType ?? item.verdict?.item_type ?? item.buy?.itemType;
  if (type && ['bag', 'small_leather_goods', 'accessory', 'jewellery'].includes(type)) return true; // unsized categories always fit
  const raw = String(item.size ?? '').toUpperCase().replace(/,/g, '.').trim();
  if (!raw) return false;
  const nums = [...raw.matchAll(/(\d{2}(?:\.\d)?)/g)].map((m) => Number(m[1]));
  const letters = raw.split(/[\s/|]+/).filter((p) => /^(XXS|XS|S|M|L|XL|XXL|XXXL|[3-9]XL)$/.test(p));
  const has = (list, n) => list.some((x) => Math.abs(x - n) < 0.01);
  // explicit shoe signals
  if (/CM/.test(raw)) return nums.some((n) => has(my.shoesCm ?? [], n) || has(my.shoesEu ?? [], n));
  const waistMatch = raw.match(/W\s?(\d{2})/);
  const inseamMatch = raw.match(/L\s?(\d{2})/);
  if (waistMatch) return has(my.waist ?? [], Number(waistMatch[1])) && (!inseamMatch || has(my.inseam ?? [], Number(inseamMatch[1])));
  const slash = raw.match(/^(\d{2})\s*\/\s*(\d{2})$/);
  if (slash && Number(slash[1]) <= 40 && Number(slash[2]) >= 28 && Number(slash[2]) <= 36) return has(my.waist ?? [], Number(slash[1])) && has(my.inseam ?? [], Number(slash[2]));
  if (type === 'shoes') return nums.some((n) => has(my.shoesEu ?? [], n));
  if (type === 'trousers') return nums.some((n) => has(my.waist ?? [], n) || has(my.clothingEu ?? [], n)) || letters.some((l) => my.clothing?.includes(l));
  if (type && ['outerwear', 'knitwear', 'top', 'dress', 'skirt'].includes(type)) return letters.some((l) => my.clothing?.includes(l)) || nums.some((n) => has(my.clothingEu ?? [], n));
  if (type && ['bag', 'small_leather_goods', 'accessory', 'jewellery'].includes(type)) return true; // unsized categories always fit
  // no category: infer from the size string itself
  if (letters.length) return letters.some((l) => my.clothing?.includes(l));
  if (nums.some((n) => n % 1 !== 0 || (n >= 39 && n <= 48))) return nums.some((n) => has(my.shoesEu ?? [], n));
  if (nums.some((n) => n >= 49 && n <= 60)) return nums.some((n) => has(my.clothingEu ?? [], n));
  if (nums.some((n) => n >= 28 && n <= 38)) return nums.some((n) => has(my.waist ?? [], n));
  return false;
}
