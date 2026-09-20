/**
 * Local CLIP embeddings (Transformers.js, runs on the Mac, no API cost) for:
 *  - zero-shot labels: category, style, colour, material, gender presentation
 *  - semantic search ("black leather bag with gold chain") and "more like this"
 * Models download once (~90 MB quantised) into ~/.cache/vinted-scraper/models.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MODEL_ID = 'Xenova/clip-vit-base-patch32';

/** Prompt sets. Each label has several phrasings; scores are averaged (prompt ensembling). */
export const TAXONOMY = {
  category: {
    'handbag': ['a photo of a handbag', 'a designer handbag', 'a shoulder bag'],
    'tote bag': ['a photo of a tote bag', 'a large tote bag'],
    'crossbody bag': ['a photo of a small crossbody bag', 'a mini bag with a chain strap'],
    'backpack': ['a photo of a backpack'],
    'wallet': ['a photo of a wallet', 'a card holder', 'a small leather pouch'],
    'sneakers': ['a photo of sneakers', 'a pair of trainers'],
    'boots': ['a photo of boots', 'a pair of ankle boots', 'knee-high boots'],
    'heels': ['a photo of high heels', 'a pair of pumps', 'stiletto shoes'],
    'flats': ['a photo of ballet flats', 'a pair of loafers', 'flat shoes'],
    'sandals': ['a photo of sandals', 'a pair of mules'],
    'coat': ['a photo of a long coat', 'a wool overcoat', 'a trench coat'],
    'jacket': ['a photo of a jacket', 'a leather jacket', 'a bomber jacket', 'a blazer'],
    'puffer': ['a photo of a puffer jacket', 'a down jacket'],
    'sweater': ['a photo of a knit sweater', 'a knit jumper', 'a cardigan'],
    'sweatshirt': ['a photo of a crewneck sweatshirt', 'a plain long-sleeve cotton sweatshirt'],
    'hoodie': ['a photo of a hoodie with a hood'],
    't-shirt': ['a photo of a t-shirt', 'a printed tee'],
    'shirt': ['a photo of a button-up shirt', 'a blouse'],
    'dress': ['a photo of a dress', 'an evening gown', 'a mini dress'],
    'skirt': ['a photo of a skirt'],
    'jeans': ['a photo of jeans', 'denim trousers'],
    'trousers': ['a photo of trousers', 'tailored pants', 'wide-leg pants'],
    'shorts': ['a photo of shorts'],
    'sunglasses': ['a photo of sunglasses', 'a pair of eyeglasses'],
    'scarf': ['a photo of a scarf', 'a silk scarf'],
    'belt': ['a photo of a belt'],
    'jewellery': ['a photo of jewellery', 'a necklace', 'a ring', 'earrings', 'a bracelet'],
    'watch': ['a photo of a wristwatch'],
    'hat': ['a photo of a hat', 'a cap', 'a beanie'],
    'lingerie': ['a photo of lingerie', 'a swimsuit', 'a bikini'],
    'other': ['a photo of a fashion accessory', 'a photo of a home decor item'],
  },
  style: {
    'quiet luxury': ['minimalist quiet luxury outfit in neutral tones', 'old money style clothing, understated and elegant'],
    'classic': ['classic timeless elegant fashion', 'a preppy classic garment'],
    'minimalist': ['minimalist scandinavian style clothing', 'clean simple modern design'],
    'streetwear': ['streetwear hype fashion', 'a hypebeast sneaker or hoodie'],
    'y2k': ['y2k 2000s fashion', 'a low-rise early 2000s style garment'],
    'vintage': ['vintage 90s fashion', 'a retro vintage garment'],
    'boho': ['bohemian boho chic clothing', 'a flowy boho garment with prints'],
    'romantic': ['romantic feminine coquette fashion with lace and bows', 'a soft feminine dress'],
    'evening': ['glamorous evening wear', 'a cocktail or party outfit', 'a sequin glamour garment'],
    'gorpcore': ['outdoor technical gorpcore clothing', 'hiking gear fashion'],
    'athleisure': ['sporty athleisure clothing', 'activewear leggings and sports top'],
    'avant-garde': ['avant-garde dark deconstructed fashion', 'an asymmetric architectural garment'],
    'grunge': ['grunge punk fashion', 'distressed rock style clothing'],
    'workwear': ['workwear utility clothing', 'a canvas work jacket or cargo pants'],
    'western': ['western cowboy style fashion', 'cowboy boots or fringe'],
    'business': ['office business formal clothing', 'a tailored suit'],
    'maximalist': ['bold colourful maximalist fashion with prints', 'a loud patterned garment'],
    'contemporary': ['a photo of a plain contemporary garment', 'a current-season fashion item with no particular style', 'a product photo of clothing', 'a plain basic sweater or t-shirt', 'a simple everyday garment on a hanger'],
  },
  color: {
    black: ['a black item', 'a pure black garment'], white: ['a white item', 'a cream item'], beige: ['a beige item', 'a camel tan item'], brown: ['a brown item'],
    grey: ['a grey item'], navy: ['a dark navy blue item', 'a midnight blue garment'], blue: ['a blue item', 'a light blue item'], green: ['a green item', 'an olive khaki item'],
    red: ['a red item', 'a burgundy item'], pink: ['a pink item'], purple: ['a purple item', 'a lilac item'], yellow: ['a yellow item', 'a mustard item'],
    orange: ['an orange item'], gold: ['a gold metallic item'], silver: ['a silver metallic item'], multicolour: ['a multicoloured patterned item'],
  },
  material: {
    leather: ['made of smooth matte leather', 'a grained leather item'], suede: ['made of suede'], 'patent leather': ['made of very shiny glossy patent leather'], denim: ['made of denim'],
    wool: ['made of wool', 'a tweed fabric'], cashmere: ['made of fine soft cashmere knit with a fuzzy halo'], silk: ['made of silk satin'], cotton: ['made of cotton', 'cotton jersey sweatshirt fabric', 'a fleece fabric'],
    knit: ['a knitted fabric'], nylon: ['made of nylon technical fabric'], canvas: ['made of canvas'], shearling: ['made of shearling or fur'],
    sequin: ['covered in sequins or crystals'], lace: ['made of lace'], metal: ['made of metal', 'a gold or silver metal object'], plastic: ['made of plastic or acetate'],
  },
  gender: {
    women: ["women's fashion item", 'a womenswear garment'], men: ["men's fashion item", 'a menswear garment'], unisex: ['a unisex item'],
  },
};

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const normalize = (arr) => {
  let n = 0;
  for (const x of arr) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(arr, (x) => x / n);
};

/**
 * Pure labelling: given an image vector and the per-group prompt vectors, return the best label
 * per group plus the top styles with softmax-ish confidence. `groups` shape:
 * { category: [{ label, vecs: Float32Array[] }, ...], style: [...], ... }
 */
export const MIN_CONFIDENCE = { category: 0.2, style: 0.3, color: 0.28, material: 0.35, gender: 0.4 };

export function labelEmbedding(vec, groups, { topStyles = 3, temperature = 100, minConfidence = MIN_CONFIDENCE } = {}) {
  const out = {};
  for (const [group, entries] of Object.entries(groups)) {
    const scored = entries.map((e) => ({ label: e.label, score: e.vecs.reduce((s, v) => s + cosine(vec, v), 0) / e.vecs.length }));
    const max = Math.max(...scored.map((s) => s.score));
    const exps = scored.map((s) => Math.exp((s.score - max) * temperature));
    const z = exps.reduce((a, b) => a + b, 0);
    const probs = scored.map((s, i) => ({ label: s.label, p: exps[i] / z })).sort((a, b) => b.p - a.p);
    const best = probs[0];
    out[group] = best.p >= (minConfidence[group] ?? 0) ? best.label : null;
    if (group === 'style' && best.label === 'contemporary') out[group] = null; // the catch-all is not a style
    if (group === 'material' && best.label === 'patent leather' && best.p < 0.5) out[group] = 'leather'; // CLIP over-reads shine; only very confident calls stay patent
    out[`${group}Confidence`] = Number(best.p.toFixed(3));
    if (group === 'style') out.styles = probs.slice(0, topStyles).map((x) => ({ label: x.label, p: Number(x.p.toFixed(3)) }));
  }
  return out;
}

let loading;
/** Lazily loads CLIP once per process. */
export async function loadClip({ cacheDir = join(homedir(), '.cache', 'vinted-scraper', 'models'), dtype = 'q8' } = {}) {
  if (!loading) {
    loading = (async () => {
      const tf = await import('@huggingface/transformers');
      tf.env.cacheDir = cacheDir;
      const [tokenizer, processor, vision, text] = await Promise.all([
        tf.AutoTokenizer.from_pretrained(MODEL_ID),
        tf.AutoProcessor.from_pretrained(MODEL_ID),
        tf.CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { dtype }),
        tf.CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { dtype }),
      ]);
      return { tf, tokenizer, processor, vision, text };
    })();
  }
  return loading;
}

export class Embedder {
  constructor({ logger, fetchImpl = globalThis.fetch } = {}) {
    this.logger = logger;
    this.fetch = fetchImpl;
    this.groups = undefined;
  }

  async ready() {
    this.clip ??= await loadClip();
    if (!this.groups) {
      this.groups = {};
      for (const [group, labels] of Object.entries(TAXONOMY)) {
        const entries = Object.entries(labels);
        const prompts = entries.flatMap(([, ps]) => ps);
        const vecs = await this.embedTexts(prompts);
        let i = 0;
        this.groups[group] = entries.map(([label, ps]) => ({ label, vecs: ps.map(() => vecs[i++]) }));
      }
    }
    return this;
  }

  async embedTexts(texts) {
    const { tokenizer, text } = await loadClip();
    const { text_embeds } = await text(tokenizer(texts, { padding: true, truncation: true }));
    const d = text_embeds.dims[1];
    return texts.map((_, i) => normalize(text_embeds.data.slice(i * d, (i + 1) * d)));
  }

  async embedText(query) {
    return (await this.embedTexts([query]))[0];
  }

  /** Embeds an image from a URL or Buffer. Vinted CDN URLs are public (signed). */
  async embedImage(source) {
    const { tf, processor, vision } = await loadClip();
    let img;
    if (Buffer.isBuffer(source)) img = await tf.RawImage.fromBlob(new Blob([source]));
    else {
      const res = await this.fetch(source, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`image ${res.status}`);
      img = await tf.RawImage.fromBlob(await res.blob());
    }
    const { image_embeds } = await vision(await processor(img));
    return normalize(image_embeds.data);
  }

  async label(vec) {
    await this.ready();
    return labelEmbedding(vec, this.groups);
  }
}

/** Ranks rows (each with `.vec`) by cosine similarity to `vec`. */
export function rankBySimilarity(vec, rows, { limit = 60, exclude } = {}) {
  const scored = [];
  for (const r of rows) {
    if (r.id === exclude) continue;
    scored.push({ id: r.id, score: cosine(vec, r.vec) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export const vecToBlob = (vec) => Buffer.from(Float32Array.from(vec).buffer);
export const blobToVec = (blob) => new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);

/**
 * Nearest-neighbour labels from human-tagged examples: for each field with enough tags, the top-k
 * most similar tagged listings vote. Overrides the zero-shot label only when the neighbours are
 * close and agree, so a handful of tags can already correct systematic mistakes.
 */
export function knnLabels(vec, examples, { k = 5, minExamples = 5, minSim = 0.82, minAgreement = 0.6, exclude } = {}) {
  const out = {};
  const byField = new Map();
  for (const ex of examples ?? []) { if (ex.id === exclude || ex.value === null) continue; (byField.get(ex.field) ?? byField.set(ex.field, []).get(ex.field)).push(ex); }
  for (const [field, list] of byField) {
    if (list.length < minExamples) continue;
    const scored = list.map((ex) => ({ value: ex.value, sim: cosine(vec, ex.vec) })).sort((a, b) => b.sim - a.sim).slice(0, k).filter((x) => x.sim >= minSim);
    if (!scored.length) continue;
    const votes = new Map();
    for (const x of scored) votes.set(x.value, (votes.get(x.value) ?? 0) + x.sim);
    const total = [...votes.values()].reduce((a, b) => a + b, 0);
    const [value, weight] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (weight / total >= minAgreement) { out[field] = value; out[`${field}Source`] = 'knn'; }
  }
  return out;
}
