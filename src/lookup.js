import { normalizeText } from './util.js';

/** Vinted item condition ("status") ids. These are global across all Vinted domains. */
export const CONDITIONS = Object.freeze({
  6: 'New with tags',
  1: 'New without tags',
  2: 'Very good',
  3: 'Good',
  4: 'Satisfactory',
});

// Localised condition labels as they appear on the site, plus common shorthand. Keys are normalised.
const CONDITION_ALIASES = {
  6: ['new', 'nwt', 'new with tags', 'brand new', 'novo s etiketama', 'novo s etiketom', 'neu mit etikett', 'neuf avec étiquette', 'nuovo con cartellino', 'nuevo con etiquetas', 'nowy z metką', 'nowe z metką', 'nieuw met prijskaartje', 'novo com etiquetas', 'nové s visačkou', 'nauja, su etiketėmis', 'új, címkével', 'nou cu etichetă', 'nytt med etikett', 'nyt med prismærke', 'jauns ar birkām', 'uus, sildiga', 'καινούργιο με ετικέτα'],
  1: ['nwot', 'new without tags', 'neu', 'novo', 'nov', 'nuovo', 'nuevo', 'neuf', 'nowy', 'nieuw', 'novo bez etiketa', 'neu ohne etikett', 'neuf sans étiquette', 'nuovo senza cartellino', 'nuevo sin etiquetas', 'nowy bez metki', 'nowe bez metki', 'nieuw zonder prijskaartje', 'novo sem etiquetas', 'nové bez visačky', 'nauja, be etikečių', 'új, címke nélkül', 'nou fără etichetă', 'nytt utan etikett', 'nyt uden prismærke', 'jauns bez birkām', 'uus, ilma sildita', 'καινούργιο χωρίς ετικέτα'],
  2: ['very good', 'vgc', 'veoma dobro', 'sehr gut', 'très bon état', 'ottime condizioni', 'muy bueno', 'muy buen estado', 'bardzo dobry', 'heel goed', 'muito bom', 'velmi dobrý', 'veľmi dobrý', 'labai gera', 'nagyon jó', 'foarte bun', 'mycket bra', 'meget god', 'ļoti labs', 'väga hea', 'πολύ καλή', 'erittäin hyvä'],
  3: ['good', 'dobro', 'gut', 'bon état', 'buone condizioni', 'bueno', 'buen estado', 'dobry', 'goed', 'bom', 'dobrý', 'gera', 'jó', 'bun', 'bra', 'god', 'labs', 'hea', 'καλή', 'hyvä'],
  4: ['satisfactory', 'zadovoljavajuće', 'zufriedenstellend', 'satisfaisant', 'soddisfacente', 'satisfactorio', 'zadowalający', 'redelijk', 'satisfatório', 'uspokojivý', 'patenkinama', 'megfelelő', 'satisfăcător', 'tillfredsställande', 'tilfredsstillende', 'apmierinošs', 'rahuldav', 'ικανοποιητική', 'tyydyttävä'],
};

const CONDITION_INDEX = new Map();
for (const [id, names] of Object.entries(CONDITION_ALIASES)) {
  CONDITION_INDEX.set(String(id), Number(id));
  CONDITION_INDEX.set(normalizeText(CONDITIONS[id]), Number(id));
  for (const n of names) CONDITION_INDEX.set(normalizeText(n), Number(id));
}

/** Returns the status id for a condition label in any supported language, or undefined. */
export function conditionIdFromText(text) {
  if (text === undefined || text === null) return undefined;
  return CONDITION_INDEX.get(normalizeText(text));
}

/** Strict variant used for user input: throws on unknown values. */
export function resolveCondition(input) {
  const id = conditionIdFromText(input);
  if (!id) {
    throw new Error(`Unknown condition ${JSON.stringify(input)}. Use one of: ${Object.entries(CONDITIONS).map(([k, v]) => `${v} (${k})`).join(', ')}`);
  }
  return id;
}

/** Vinted colour ids (global). Best-effort list; pass numeric ids directly for anything missing. */
export const COLORS = Object.freeze({
  1: 'Black', 2: 'Brown', 3: 'Grey', 4: 'Beige', 5: 'Pink', 6: 'Purple', 7: 'Red', 8: 'Yellow', 9: 'Blue',
  10: 'Green', 11: 'Orange', 12: 'White', 13: 'Silver', 14: 'Gold', 15: 'Multi', 16: 'Khaki', 17: 'Turquoise',
  18: 'Cream', 19: 'Apricot', 20: 'Coral', 21: 'Burgundy', 22: 'Rose', 23: 'Lilac', 24: 'Light blue',
  25: 'Navy', 26: 'Dark green', 27: 'Mustard', 28: 'Mint', 29: 'Clear', 30: 'Menthol',
});

const COLOR_ALIASES = { crna: 1, smeda: 2, siva: 3, bez: 4, roza: 5, ruza: 5, ljubicasta: 6, crvena: 7, zuta: 8, plava: 9, zelena: 10, narancasta: 11, bijela: 12, srebrna: 13, zlatna: 14, gray: 3, multicolor: 15, multicolour: 15 };

export function resolveColor(input) {
  const n = normalizeText(input);
  if (/^\d+$/.test(n)) return Number(n);
  if (COLOR_ALIASES[n]) return COLOR_ALIASES[n];
  for (const [id, name] of Object.entries(COLORS)) if (normalizeText(name) === n) return Number(id);
  throw new Error(`Unknown colour ${JSON.stringify(input)}. Known: ${Object.values(COLORS).join(', ')} (or pass a numeric id)`);
}

export const ORDERS = Object.freeze({
  newest: 'newest_first',
  newest_first: 'newest_first',
  relevance: 'relevance',
  price_asc: 'price_low_to_high',
  price_low_to_high: 'price_low_to_high',
  cheapest: 'price_low_to_high',
  price_desc: 'price_high_to_low',
  price_high_to_low: 'price_high_to_low',
});

export function resolveOrder(input) {
  if (input === undefined || input === null || input === '') return undefined;
  const v = ORDERS[String(input).toLowerCase()];
  if (!v) throw new Error(`Unknown order ${JSON.stringify(input)}. Use: ${Object.keys(ORDERS).join(', ')}`);
  return v;
}

/** Flattens a nested catalog tree into [{ id, title, path, depth, parentId }]. */
export function flattenCatalogs(tree, parentPath = '', depth = 0, parentId = undefined, out = []) {
  for (const node of tree ?? []) {
    const path = parentPath ? `${parentPath} > ${node.title}` : node.title;
    const slug = node.url?.match(/\/catalog\/\d+-([a-z0-9-]+)/)?.[1]?.replace(/-/g, ' ');
    out.push({ id: node.id, title: node.title, code: node.code, slug, path, depth, parentId, url: node.url });
    flattenCatalogs(node.catalogs, path, depth + 1, node.id, out);
  }
  return out;
}

/**
 * Picks the best entry for a free-text query: exact > prefix > substring (all normalised).
 * Ties are broken by the shortest title so "Nike" beats "Nike Air" for the query "nike".
 */
export function bestMatch(list, query, keys = 'title') {
  const q = normalizeText(query);
  if (!q) return undefined;
  const keyList = Array.isArray(keys) ? keys : [keys];
  let best;
  let bestScore = Infinity;
  for (const entry of list) {
    for (let k = 0; k < keyList.length; k++) {
      const t = normalizeText(entry[keyList[k]]);
      if (!t) continue;
      let rank;
      if (t === q) rank = 0;
      else if (t.startsWith(q)) rank = 1;
      else if (t.includes(q)) rank = 2;
      else continue;
      // exact match on any key beats a prefix match on any key; earlier keys win ties; shorter wins after that
      const score = rank * 10000 + k * 1000 + t.length;
      if (score < bestScore) {
        bestScore = score;
        best = entry;
      }
    }
  }
  return best;
}

/** Maps a Vinted TLD to the Accept-Language the site expects for that market. */
export const DOMAIN_LOCALES = Object.freeze({
  hr: 'hr-HR', fr: 'fr-FR', de: 'de-DE', com: 'en-US', 'co.uk': 'en-GB', pl: 'pl-PL', it: 'it-IT', es: 'es-ES',
  nl: 'nl-NL', lt: 'lt-LT', cz: 'cs-CZ', sk: 'sk-SK', pt: 'pt-PT', at: 'de-AT', be: 'fr-BE', lu: 'fr-LU', se: 'sv-SE',
  ro: 'ro-RO', hu: 'hu-HU', dk: 'da-DK', fi: 'fi-FI', gr: 'el-GR', ie: 'en-IE', ee: 'et-EE', lv: 'lv-LV', si: 'sl-SI',
  'com.au': 'en-AU',
});
