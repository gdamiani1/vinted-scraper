import { brandTier } from './rules.js';
import { MODEL_ID } from './embed.js';

/** Embeds and labels listings that have no embedding yet (main thumbnail only). Returns how many were done. */
export async function embedNewItems({ store, embedder, limit = 500, concurrency = 4, logger }) {
  const todo = store.itemsNeedingEmbedding(limit);
  if (!todo.length) return 0;
  await embedder.ready();
  let next = 0;
  let done = 0;
  let failed = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (next < todo.length) {
      const it = todo[next++];
      try {
        const vec = await embedder.embedImage(it.thumbnail ?? it.photos?.[0]);
        const labels = await embedder.label(vec);
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
  let n = 0;
  store.db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (r.vec.every((x) => x === 0)) continue; // placeholder for a missing image
      const labels = await embedder.label(r.vec);
      store.q.setLabels.run(labels.category ?? null, labels.style ?? null, labels.color ?? null, labels.material ?? null, labels.gender ?? null, JSON.stringify(labels), r.id);
      n++;
    }
    store.db.exec('COMMIT');
  } catch (e) { store.db.exec('ROLLBACK'); throw e; }
  logger?.info(`[embed] relabelled ${n} listings`);
  return n;
}
