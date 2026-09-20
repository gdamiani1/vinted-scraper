import { brandTier } from './rules.js';
import { MODEL_ID } from './embed.js';
import { dominantGarmentColor } from './color.js';
import { knnLabels } from './embed.js';

async function fetchImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`image ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Embeds and labels listings that have no embedding yet (main thumbnail only). Returns how many were done. */
export async function embedNewItems({ store, embedder, limit = 500, concurrency = 4, logger }) {
  const todo = store.itemsNeedingEmbedding(limit);
  if (!todo.length) return 0;
  await embedder.ready();
  let examples;
  let next = 0;
  let done = 0;
  let failed = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (next < todo.length) {
      const it = todo[next++];
      try {
        const buf = await fetchImage(it.thumbnail ?? it.photos?.[0]);
        const vec = await embedder.embedImage(buf);
        const labels = { ...(await embedder.label(vec)), ...knnLabels(vec, examples ??= store.humanExamples()) };
        try { const col = await dominantGarmentColor(buf); labels.colorClip = labels.color; labels.color = col.name; labels.colorHex = col.hex; labels.colorShare = col.share; } catch { /* keep CLIP colour */ }
        store.putEmbedding(it.id, vec, MODEL_ID, labels);
        done++;
        if (done % 200 === 0) logger?.info(`[embed] ${done}/${todo.length} (${((Date.now() - t0) / 1000 / done).toFixed(2)} s each)`);
      } catch (e) {
        failed++;
        logger?.debug(`[embed] ${it.id}: ${e.message}`);
        if (/image 4\d\d/.test(e.message)) store.putEmbedding(it.id, new Float32Array(512), MODEL_ID + ':missing', undefined); // image gone: don't retry forever
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  if (failed) logger?.warn(`[embed] ${failed} listings failed (missing images)`);
  return done;
}

/**
 * Nightly broad status check: every luxury-tier listing seen in the last 14 days that has not
 * been checked in ~20 hours. Feeds the sell-through statistics.
 */
export async function broadRecheck({ scraper, store, rules, limit = 1000, days = 14, logger, signal }) {
  const candidates = store.toRecheckBroad({ days, limit: limit * 3 }).filter((it) => brandTier(it.brand, rules) !== 'other').slice(0, limit);
  let checked = 0;
  let gone = 0;
  for (const it of candidates) {
    if (signal?.aborted) break;
    let status;
    try {
      const d = await scraper.item(it.id);
      status = d.flags.isReserved ? 'reserved' : d.flags.isHidden || !d.flags.canBuy ? 'sold' : 'available';
    } catch (e) {
      if (e.code === 'NOT_FOUND') status = 'removed';
      else if (e.code === 'BLOCKED') { logger?.warn(`[recheck] blocked by Vinted after ${checked} checks; stopping tonight's pass`); break; }
    }
    if (!status) continue;
    store.setStatus(it.id, status);
    checked++;
    if (status !== 'available' && it.status !== status) gone++;
  }
  return { checked, gone, candidates: candidates.length };
}

/** Recomputes labels for every stored vector (taxonomy or threshold changes), no image downloads. */
export async function relabelAll({ store, embedder, logger }) {
  await embedder.ready();
  const rows = store.allEmbeddings();
  const prevLabels = new Map(store.db.prepare('SELECT id, labels FROM items WHERE labels IS NOT NULL').all().map((r) => [r.id, JSON.parse(r.labels)]));
  const examples = store.humanExamples();
  let n = 0;
  store.db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (r.vec.every((x) => x === 0)) continue; // placeholder for a missing image
      const labels = { ...(await embedder.label(r.vec)), ...knnLabels(r.vec, examples, { exclude: r.id }) };
      const prev = prevLabels.get(r.id);
      if (prev?.colorHex) { labels.colorClip = labels.color; labels.color = prev.color; labels.colorHex = prev.colorHex; labels.colorShare = prev.colorShare; }
      store.applyLabels(r.id, labels);
      n++;
    }
    store.db.exec('COMMIT');
  } catch (e) { store.db.exec('ROLLBACK'); throw e; }
  logger?.info(`[embed] relabelled ${n} listings`);
  return n;
}

/** Re-reads colour from pixels for every embedded listing (thumbnails re-downloaded, ~5 ms each to analyse). */
export async function recolorAll({ store, concurrency = 6, logger }) {
  const rows = store.db.prepare("SELECT id, json, labels FROM items WHERE EXISTS (SELECT 1 FROM embeddings e WHERE e.item_id = items.id) AND (labels IS NULL OR json_extract(labels, '$.colorHex') IS NULL)").all();
  let next = 0, done = 0, failed = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (next < rows.length) {
      const r = rows[next++];
      try {
        const it = JSON.parse(r.json);
        const col = await dominantGarmentColor(await fetchImage(it.thumbnail ?? it.photos?.[0]));
        const labels = r.labels ? JSON.parse(r.labels) : {};
        labels.colorClip = labels.colorClip ?? labels.color; labels.color = col.name; labels.colorHex = col.hex; labels.colorShare = col.share;
        store.applyLabels(r.id, labels);
        done++;
        if (done % 500 === 0) logger?.info(`[recolor] ${done}/${rows.length} (${((Date.now() - t0) / 1000 / done).toFixed(2)} s each)`);
      } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  logger?.info(`[recolor] ${done} recoloured, ${failed} failed`);
  return done;
}
