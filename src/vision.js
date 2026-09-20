import { VintedError } from './util.js';

/** Strict JSON the vision model must return. Keep flat-ish: some providers reject deep schemas. */
export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['item_type', 'gender', 'brand_seen', 'line_or_model', 'condition_grade', 'condition_notes', 'authenticity_risk', 'authenticity_observations', 'completeness', 'photo_quality', 'size_visible', 'resale_estimate_eur', 'red_flags', 'summary', 'confidence'],
  properties: {
    item_type: { type: 'string', enum: ['bag', 'small_leather_goods', 'shoes', 'outerwear', 'knitwear', 'dress', 'skirt', 'trousers', 'top', 'accessory', 'jewellery', 'other'] },
    gender: { type: 'string', enum: ['men', 'women', 'unisex', 'kids'], description: 'Who the piece is cut for, from the item itself (not the seller)' },
    brand_seen: { type: ['string', 'null'], description: 'Brand as visible on the item/tags, null if not visible' },
    line_or_model: { type: ['string', 'null'], description: 'Specific line/model, e.g. "Classic Flap Medium", "Speedy 30", "Triple S"' },
    condition_grade: { type: 'string', enum: ['new', 'excellent', 'very_good', 'good', 'fair', 'poor'] },
    condition_notes: { type: 'array', items: { type: 'string' } },
    authenticity_risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    authenticity_observations: { type: 'array', items: { type: 'string' }, description: 'Concrete visible evidence for or against authenticity' },
    completeness: { type: 'array', items: { type: 'string', enum: ['box', 'dust_bag', 'receipt', 'authenticity_card', 'tags', 'extra_strap', 'none_visible'] } },
    photo_quality: { type: 'string', enum: ['real_photos', 'stock_images', 'mixed', 'too_few_or_blurry'] },
    size_visible: { type: ['string', 'null'] },
    resale_estimate_eur: { type: ['object', 'null'], additionalProperties: false, required: ['low', 'high'], properties: { low: { type: 'number' }, high: { type: 'number' } } },
    red_flags: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

const SYSTEM_PROMPT = `You are the buying assistant for a second-hand luxury fashion reseller. You are shown photos and the text of a Vinted listing. Judge only from what is visible; do not invent details. Be specific and sceptical: sellers of fakes use stock images, blurry photos, and hide date codes, hardware and stitching.

Report:
- item_type and the exact line/model if recognisable.
- condition_grade from the photos, with concrete condition_notes (corner wear, sole wear, stains, hardware scratches, pilling, missing parts).
- authenticity_risk with authenticity_observations: name the features you checked (stitch count/regularity, hardware engraving, logo font and alignment, quilting alignment, heat stamp, date/serial code, lining, packaging). "high" only when you see a concrete inconsistency; "medium" when key features are not visible; "low" when several key features look right.
- completeness (box, dust bag, receipt, authenticity card, tags).
- photo_quality: stock_images if the photos look like brand/retailer product shots rather than the seller's own item.
- resale_estimate_eur: a realistic low/high range for this exact item in this condition on the European second-hand market, or null if you cannot say.
- red_flags: anything a buyer should worry about (price far below market, "read description", reserved/bundle wording, mismatched size, suspicious seller claims).
- summary: one sentence a human buyer reads first.
- confidence 0-1 in your overall assessment.
Respond with a single JSON object only (no schema, no markdown) with exactly these keys:
gender (men, women, unisex, kids — judge from the cut, size system and category, not the seller), item_type (one of: bag, small_leather_goods, shoes, outerwear, knitwear, dress, skirt, trousers, top, accessory, jewellery, other — boots/sneakers/heels are shoes; wallets/pouches/belts are small_leather_goods; jackets/coats are outerwear), brand_seen, line_or_model, condition_grade (new, excellent, very_good, good, fair, poor), condition_notes[], authenticity_risk (low, medium, high), authenticity_observations[], completeness[] (box, dust_bag, receipt, authenticity_card, tags, extra_strap, none_visible), photo_quality (real_photos, stock_images, mixed, too_few_or_blurry), size_visible, resale_estimate_eur {low, high} or null, red_flags[], summary, confidence (0-1).`;

const ITEM_TYPES = new Set(['bag', 'small_leather_goods', 'shoes', 'outerwear', 'knitwear', 'dress', 'skirt', 'trousers', 'top', 'accessory', 'jewellery', 'other']);
const RISKS = new Set(['low', 'medium', 'high']);
const TYPE_SYNONYMS = [
  [/\b(boot|bootie|sneaker|trainer|heel|pump|sandal|loafer|mule|flat|slipper|shoe|footwear|espadrille|derby|oxford|brogue)/, 'shoes'],
  [/\b(wallet|card ?holder|purse|pouch|coin|key ?(case|holder)|belt)\b/, 'small_leather_goods'],
  [/\b(bag|handbag|tote|clutch|backpack|crossbody|shoulder|satchel|hobo|flap|bucket|messenger|briefcase)/, 'bag'],
  [/\b(jacket|coat|blazer|parka|trench|puffer|bomber|vest|gilet|outerwear|windbreaker|anorak)/, 'outerwear'],
  [/\b(sweater|cardigan|jumper|knit|pullover|hoodie|sweatshirt|turtleneck)/, 'knitwear'],
  [/\b(dress|gown)\b/, 'dress'],
  [/\bskirt/, 'skirt'],
  [/\b(trouser|pant|jean|denim|short|chino|legging|jogger)/, 'trousers'],
  [/\b(shirt|blouse|top|tee|t-shirt|polo|tank|bodysuit|camisole)/, 'top'],
  [/\b(necklace|ring|bracelet|earring|brooch|pendant|jewel|watch)/, 'jewellery'],
  [/\b(scarf|hat|cap|beanie|sunglass|glasses|eyewear|tie|glove|umbrella|keychain|charm|hair|headband|accessor)/, 'accessory'],
];
const CONDITION_SYNONYMS = { 'like new': 'excellent', 'as new': 'excellent', 'mint': 'excellent', 'very good': 'very_good', 'verygood': 'very_good', 'used': 'good', 'worn': 'fair', 'satisfactory': 'fair', 'bad': 'poor', 'new with tags': 'new', 'new without tags': 'new', 'brand new': 'new', 'unworn': 'new' };
function canonicalType(t) {
  const s = String(t ?? '').toLowerCase().replace(/[_-]/g, ' ').trim();
  if (ITEM_TYPES.has(s.replace(/ /g, '_'))) return s.replace(/ /g, '_');
  for (const [re, type] of TYPE_SYNONYMS) if (re.test(s)) return type;
  return 'other';
}
function canonicalCondition(c) {
  const s = String(c ?? '').toLowerCase().replace(/[_-]/g, ' ').trim();
  if (CONDITION_SYNONYMS[s]) return CONDITION_SYNONYMS[s];
  const k = s.replace(/ /g, '_');
  return ['new', 'excellent', 'very_good', 'good', 'fair', 'poor'].includes(k) ? k : 'good';
}

/** Returns a normalised verdict, or undefined when the payload is not a usable verdict. */
export function normalizeVerdict(raw) {
  let v = raw;
  if (Array.isArray(v)) v = v.find((x) => x && typeof x === 'object' && !('properties' in x)) ?? v[0];
  if (!v || typeof v !== 'object' || 'properties' in v || '$schema' in v) return undefined;
  if (typeof v.item_type !== 'string' || typeof v.authenticity_risk !== 'string') return undefined;
  const out = { ...v };
  out.item_type = canonicalType(out.item_type);
  out.condition_grade = canonicalCondition(out.condition_grade);
  out.gender = ['men', 'women', 'unisex', 'kids'].includes(String(out.gender).toLowerCase()) ? String(out.gender).toLowerCase() : undefined;
  out.authenticity_risk = RISKS.has(String(out.authenticity_risk).toLowerCase()) ? String(out.authenticity_risk).toLowerCase() : 'medium';
  if (typeof out.photo_quality === 'string') out.photo_quality = out.photo_quality.toLowerCase().replace(/[ -]/g, '_');
  for (const k of ['condition_notes', 'authenticity_observations', 'completeness', 'red_flags']) if (!Array.isArray(out[k])) out[k] = out[k] ? [String(out[k])] : [];
  if (out.resale_estimate_eur && (!Number.isFinite(Number(out.resale_estimate_eur.low)) || !Number.isFinite(Number(out.resale_estimate_eur.high)))) out.resale_estimate_eur = null;
  if (out.resale_estimate_eur) out.resale_estimate_eur = { low: Number(out.resale_estimate_eur.low), high: Number(out.resale_estimate_eur.high) };
  out.confidence = Number.isFinite(Number(out.confidence)) ? Math.min(1, Math.max(0, Number(out.confidence))) : 0.5;
  return out;
}

function stripFences(text) {
  const m = String(text ?? '').trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : String(text ?? '').trim();
}

export function estimateCost(usage, pricePerMillion) {
  if (!usage || !pricePerMillion) return undefined;
  const c = (usage.promptTokens ?? 0) * (pricePerMillion.prompt ?? 0) / 1e6 + (usage.completionTokens ?? 0) * (pricePerMillion.completion ?? 0) / 1e6;
  return Math.round(c * 1e6) / 1e6;
}

/**
 * OpenAI-compatible chat-completions client for vision verdicts. Defaults to OpenRouter with
 * Qwen 3.8 Flash; any provider exposing the same API works (DashScope, Zhipu, Ollama, ...).
 */
export function createVisionClient({
  baseUrl = process.env.VISION_BASE_URL ?? 'https://openrouter.ai/api/v1',
  apiKey = process.env.VISION_API_KEY ?? process.env.OPENROUTER_API_KEY,
  model = process.env.VISION_MODEL ?? 'qwen/qwen3.8-flash',
  maxPhotos = 6,
  timeoutMs = 90000,
  pricePerMillion,
  fetchImpl = globalThis.fetch,
  logger,
} = {}) {
  if (!apiKey) throw new VintedError('No vision API key. Set OPENROUTER_API_KEY (or VISION_API_KEY with VISION_BASE_URL).', { code: 'NO_API_KEY' });
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  async function request(body, { timeout = timeoutMs } = {}) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'http-referer': 'https://github.com/vinted-scraper', 'x-title': 'vinted-scraper' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new VintedError(`Vision API ${res.status}: ${text.slice(0, 300)}`, { code: res.status === 401 ? 'NO_API_KEY' : 'VISION', status: res.status });
    }
    return res.json();
  }

  return {
    model,
    baseUrl,
    /**
     * Text-only screening of many listings in one call (no photos): which are plausibly genuine
     * luxury items priced below resale and worth a photo check. ~30 tokens per listing.
     * @returns Map<id, { worth_checking, est_resale_eur, reason }>
     */
    async triage(listings, { batchSize = 30, concurrency = 12 } = {}) {
      const out = new Map();
      const batches = [];
      for (let i = 0; i < listings.length; i += batchSize) batches.push(listings.slice(i, i + batchSize));
      let next = 0;
      const runBatch = async (batch, i) => {
        const lines = batch.map((l) => `${l.id} | ${l.brand ?? '?'} | ${l.title ?? ''} | size ${l.size ?? '-'} | ${l.condition ?? '-'} | ${l.price} ${l.currency ?? 'EUR'}`).join('\n');
        const body = {
          model,
          temperature: 0.1,
          max_tokens: 4000,
          reasoning: { enabled: false, exclude: true }, // classification: no hidden thinking, answer fast
          messages: [
            { role: 'system', content: 'You are a buyer for a second-hand luxury fashion reseller screening Vinted listings by text only. For each listing decide if it is worth opening for a photo check: a real product (not packaging, dust bags, boxes, samples, perfume, magazines, hangers, or "inspired"/dupe items), from the stated luxury brand, in a category that resells (bags, small leather goods, shoes, outerwear, knitwear, dresses, jewellery, sunglasses), and with an asking price plausibly below what it resells for in Europe. Estimate a realistic second-hand resale value in EUR for each. Respond with JSON only: {"picks":[{"id":<number>,"worth_checking":<bool>,"est_resale_eur":<number|null>,"reason":"<short>"}]} with one entry per listing.' },
            { role: 'user', content: `id | brand | title | size | condition | price\n${lines}` },
          ],
          response_format: { type: 'json_object' },
        };
        let data;
        try { data = await request(body, { timeout: 180000 }); } catch (e) { logger?.debug(`triage batch ${i + 1} retry: ${e.message}`); data = await request(body, { timeout: 180000 }); }
        const content = data.choices?.[0]?.message?.content;
        let parsed;
        try { parsed = JSON.parse(stripFences(typeof content === 'string' ? content : '')); } catch { parsed = undefined; }
        const picks = Array.isArray(parsed?.picks) ? parsed.picks : Array.isArray(parsed) ? parsed : [];
        for (const p of picks) if (p && p.id !== undefined) out.set(Number(p.id), { worth_checking: Boolean(p.worth_checking), est_resale_eur: Number.isFinite(Number(p.est_resale_eur)) ? Number(p.est_resale_eur) : undefined, reason: p.reason });
        logger?.[(i + 1) % 25 === 0 || i + 1 === batches.length ? 'info' : 'debug'](`triage batch ${i + 1}/${batches.length}: ${picks.length}/${batch.length} answered, ${picks.filter((p) => p.worth_checking).length} picked`);
      };
      const worker = async () => {
        while (next < batches.length) {
          const i = next++;
          try { await runBatch(batches[i], i); } catch (e) { logger?.warn(`triage batch ${i + 1} failed: ${e.message}`); }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, worker));
      return out;
    },
    /** @param listing normalised listing, optionally with `detail` (description, more photos) */
    async analyze(listing) {
      const d = listing.detail ?? {};
      const photos = [...new Set([...(d.photos ?? []), ...(listing.photos ?? [])])].slice(0, maxPhotos);
      const facts = [
        `Title: ${listing.title ?? d.title ?? ''}`,
        `Brand (seller-declared): ${listing.brand ?? d.brand?.title ?? 'unknown'}`,
        `Size (seller-declared): ${listing.size ?? d.size?.value ?? 'not given'}`,
        `Condition (seller-declared): ${listing.condition ?? d.condition ?? 'not given'}`,
        `Asking price: ${listing.price ?? d.price} ${listing.currency ?? d.currency ?? ''}`,
        d.description ? `Description: ${String(d.description).slice(0, 1500)}` : null,
        d.color ? `Colour: ${d.color}` : null,
        d.seller ? `Seller: ${d.seller.feedbackCount ?? '?'} reviews, reputation ${d.seller.feedbackReputation ?? '?'}` : null,
        `Photos attached: ${photos.length}`,
      ].filter(Boolean).join('\n');
      const body = {
        model,
        temperature: 0.1,
        max_tokens: 8000, // reasoning models spend output tokens thinking before the JSON
        reasoning: { effort: 'low' }, // OpenRouter-normalised; ignored by providers without reasoning
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: [{ type: 'text', text: facts }, ...photos.map((u) => ({ type: 'image_url', image_url: { url: u, detail: 'high' } }))] },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'listing_verdict', strict: true, schema: VERDICT_SCHEMA } },
      };
      let data;
      try {
        data = await request(body);
      } catch (e) {
        if (e.status !== 400) throw e;
        logger?.debug(`json_schema rejected by ${model}; retrying with json_object`);
        data = await request({ ...body, response_format: { type: 'json_object' } });
      }
      let choice = data.choices?.[0];
      let content = choice?.message?.content;
      if ((content === null || content === undefined || content === '') && choice?.finish_reason === 'length') {
        // The model burned its budget on hidden reasoning; try once more with reasoning disabled.
        logger?.debug(`${model} hit max_tokens while reasoning; retrying with reasoning disabled`);
        data = await request({ ...body, reasoning: { enabled: false, exclude: true } });
        choice = data.choices?.[0];
        content = choice?.message?.content;
      }
      logger?.debug(`vision raw response: ${JSON.stringify(data).slice(0, 1500)}`);
      if (content === null || content === undefined || content === '') {
        const why = data.error?.message ?? choice?.error?.message ?? choice?.message?.refusal ?? choice?.finish_reason ?? 'no content';
        throw new VintedError(`Vision model returned no content (${why}). Raw: ${JSON.stringify(data).slice(0, 400)}`, { code: 'VISION_EMPTY' });
      }
      const parse = (c) => JSON.parse(stripFences(typeof c === 'string' ? c : c?.map?.((p) => p.text).join('') ?? ''));
      let verdict;
      try {
        verdict = normalizeVerdict(parse(content));
      } catch { /* fall through to retry */ }
      if (!verdict) {
        // Some providers echo the schema back or return prose under strict json_schema; plain JSON mode + the key list in the prompt is more reliable.
        logger?.debug(`${model} returned an unusable verdict under json_schema; retrying with json_object`);
        data = await request({ ...body, reasoning: { effort: 'low' }, response_format: { type: 'json_object' } });
        choice = data.choices?.[0];
        content = choice?.message?.content;
        try {
          verdict = normalizeVerdict(parse(content));
        } catch (e) {
          throw new VintedError(`Vision model returned non-JSON: ${String(content).slice(0, 200)}`, { code: 'VISION_PARSE', cause: e });
        }
        if (!verdict) throw new VintedError(`Vision model returned JSON that is not a verdict: ${String(content).slice(0, 200)}`, { code: 'VISION_PARSE' });
      }
      const usage = { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens };
      return { verdict, usage, model: data.model ?? model, cost: estimateCost(usage, pricePerMillion), photosSent: photos.length };
    },
  };
}

/** Runs the vision client on a listing, caching the verdict per (item, model) in the store. */
export async function analyzeListing(listing, { client, store, force = false } = {}) {
  const cached = !force && store?.getVerdict(listing.id, client.model);
  if (cached && normalizeVerdict(cached.verdict)) return { ...cached, verdict: normalizeVerdict(cached.verdict), cached: true };
  const result = await client.analyze(listing);
  store?.putVerdict(listing.id, client.model, result);
  return { ...result, cached: false };
}
