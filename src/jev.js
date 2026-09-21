/**
 * Jev (TypeSafe AI "System One" model): typed decisions with calibrated probabilities instead of
 * text. ~100 ms per call, $0.042 per million input tokens, output free. Text only (no images), so
 * it replaces the LLM text triage and adds a text-based second opinion on category and gender.
 * Photo verdicts stay with the vision model.
 *
 * API: POST https://api.typesafe.ai/v1/systemone  { model, state, questions }  → { answers, usage }
 * Question types: noul (yes/no probability), choice (option + probabilities), score (2-10 levels).
 */
import { VintedError } from './util.js';
import { TAXONOMY } from './embed.js';

export const RESALE_BANDS = { under_50: 30, '50_100': 75, '100_200': 150, '200_500': 325, '500_1000': 700, '1000_2500': 1600, over_2500: 4000 };

const CATEGORY_CRITERIA = Object.fromEntries(Object.keys(TAXONOMY.category).map((k) => [k.replace(/[^a-z0-9]+/g, '_'), `The item is a ${k}`]));
const CATEGORY_KEYS = Object.fromEntries(Object.keys(TAXONOMY.category).map((k) => [k.replace(/[^a-z0-9]+/g, '_'), k]));

/** Stage 1 (every listing, small): is it worth a look at all, and what would it resell for. */
export function gateQuestions() {
  const q = triageQuestions();
  return { worth_checking: q.worth_checking, is_packaging: q.is_packaging, replica_signal: q.replica_signal, resale_band: q.resale_band };
}

/** Stage 2 (picks only, larger because of the category list): what it is and who it is for. */
export function labelQuestions() {
  const q = triageQuestions();
  return { category: q.category, gender: q.gender };
}

/** The full question set. Kept identical across calls so Jev's answers stay comparable. */
export function triageQuestions() {
  return {
    worth_checking: {
      type: 'noul',
      instructions: 'Is this Vinted listing plausibly a genuine, resellable product from the stated luxury or designer brand, offered at an asking price that a second-hand reseller could profit from? Consider the brand, item type, condition and price together.',
      criteria: { true: 'A real product of a resellable brand and category, priced below its likely second-hand value', false: 'Packaging, sample, non-product, counterfeit signal, unresellable category, or priced at or above resale value' },
    },
    is_packaging: {
      type: 'noul',
      instructions: 'Is the listing selling only packaging, a dust bag, an empty box, a shopping bag, a perfume, a sample, a magazine, a hanger or another non-garment accessory of the brand rather than an actual product?',
      criteria: { true: 'Only packaging or a non-product item', false: 'An actual product (garment, shoes, bag, accessory, jewellery)' },
    },
    replica_signal: {
      type: 'noul',
      instructions: 'Does the title or description signal that the item is not authentic: words like dupe, replica, inspired, style, 1:1, copy, "no original", or a brand name used descriptively for an unbranded item?',
      criteria: { true: 'Wording suggests a counterfeit, replica or unbranded lookalike', false: 'No such wording' },
    },
    category: { type: 'choice', instructions: 'What kind of product is this listing? Judge from the title and description.', criteria: { ...CATEGORY_CRITERIA, other: 'None of the listed categories' } },
    gender: { type: 'choice', instructions: 'Who is the piece cut for, judging from the item, category and size system (not the seller)?', criteria: { women: "Women's item", men: "Men's item", unisex: 'Unisex item', kids: "Children's item" } },
    resale_band: {
      type: 'choice',
      instructions: 'Estimate what this exact item, in the stated condition, would sell for second-hand in Europe today (EUR). Pick the band.',
      criteria: Object.fromEntries(Object.keys(RESALE_BANDS).map((k) => [k, k === 'under_50' ? 'Under 50 EUR' : k === 'over_2500' ? 'Over 2500 EUR' : `${k.replace('_', ' to ')} EUR`])),
    },
  };
}

export function listingState(l) {
  return {
    brand: l.brand ?? null,
    title: l.title ?? null,
    description: l.detail?.description ? String(l.detail.description).slice(0, 800) : null,
    size: l.size ?? null,
    condition: l.condition ?? null,
    asking_price_eur: l.price ?? null,
    seller_reviews: l.detail?.seller?.feedbackCount ?? null,
  };
}

/** Turns Jev answers into the triage shape the pipeline already uses. */
export function interpretTriage(answers, price) {
  const a = answers ?? {};
  const band = a.resale_band?.choice;
  const est = band ? RESALE_BANDS[band] : undefined;
  const pWorth = a.worth_checking?.noul ?? 0;
  const pPack = a.is_packaging?.noul ?? 0;
  const pFake = a.replica_signal?.noul ?? 0;
  const worth = pWorth >= 0.5 && pPack < 0.5 && pFake < 0.5 && (est === undefined || price === undefined || est > price);
  const reasons = [];
  if (pPack >= 0.5) reasons.push(`packaging/non-product (${Math.round(pPack * 100)}%)`);
  if (pFake >= 0.5) reasons.push(`replica wording (${Math.round(pFake * 100)}%)`);
  if (est !== undefined) reasons.push(`resale ~${est} EUR (${band}, conf ${Math.round((a.resale_band?.confidence ?? 0) * 100)}%)`);
  reasons.push(`worth checking ${Math.round(pWorth * 100)}%`);
  return {
    worth_checking: worth,
    est_resale_eur: est,
    reason: reasons.join('; '),
    category: a.category?.choice && a.category.choice !== 'other' ? CATEGORY_KEYS[a.category.choice] : undefined,
    categoryConfidence: a.category?.confidence,
    gender: a.gender?.choice,
    genderConfidence: a.gender?.confidence,
    source: 'jev',
  };
}

export function createJevClient({ apiKey = process.env.TYPESAFE_API_KEY, model = 'jev-latest', baseUrl = 'https://api.typesafe.ai/v1', fetchImpl = globalThis.fetch, concurrency = 16, logger } = {}) {
  if (!apiKey) return undefined;
  const url = `${baseUrl.replace(/\/$/, '')}/systemone`;
  let spentTokens = 0;

  async function ask(state, questions, attempt = 0) {
    const res = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, state, questions }), signal: AbortSignal.timeout(30000) });
    if (res.status === 429 || res.status === 529) {
      if (attempt >= 4) throw new VintedError(`Jev ${res.status} after retries`, { code: 'JEV', status: res.status });
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      return ask(state, questions, attempt + 1);
    }
    if (!res.ok) throw new VintedError(`Jev API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`, { code: res.status === 401 ? 'NO_API_KEY' : 'JEV', status: res.status });
    const data = await res.json();
    spentTokens += data.usage?.input_tokens ?? 0;
    return data;
  }

  return {
    model,
    kind: 'jev',
    ask,
    get spentUsd() { return (spentTokens * 0.042) / 1e6; },
    /** Same contract as the vision client's triage: Map<id, { worth_checking, est_resale_eur, reason, ... }>. */
    async triage(listings) {
      const out = new Map();
      const gate = gateQuestions();
      const labels = labelQuestions();
      let next = 0;
      let failed = 0;
      const t0 = Date.now();
      const worker = async () => {
        while (next < listings.length) {
          const l = listings[next++];
          try {
            const state = listingState(l);
            const first = await ask(state, gate);
            const t = interpretTriage(first.answers, l.price);
            if (t.worth_checking) { // only picks pay for the category list
              const second = await ask(state, labels).catch(() => undefined);
              if (second) Object.assign(t, interpretTriage({ ...first.answers, ...second.answers }, l.price));
            }
            out.set(l.id, t);
          } catch (e) {
            failed++;
            if (e.code === 'NO_API_KEY') throw e;
            logger?.debug(`[jev] ${l.id}: ${e.message}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, listings.length) }, worker));
      logger?.info(`[jev] triaged ${out.size}/${listings.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s${failed ? `, ${failed} failed` : ''}, ~$${this.spentUsd.toFixed(3)} so far`);
      return out;
    },
  };
}
