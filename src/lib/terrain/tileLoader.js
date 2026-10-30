// Main-thread side of tileWorker.js: a small worker pool, replies matched by job id.

// Road beds and mosaics are CPU work; each worker keeps its own elevation / road caches.
const WORKER_COUNT = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));

let workers = null; // [{ worker, jobs: Map(id -> resolve) }]
let nextId = 1;

function getWorkers() {
  if (workers) return workers;
  workers = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    const slot = { worker: new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' }), jobs: new Map() };
    slot.worker.onmessage = ({ data }) => {
      const resolve = slot.jobs.get(data.id);
      slot.jobs.delete(data.id);
      resolve?.(data);
    };
    slot.worker.onerror = (err) => {
      // Fail every outstanding job rather than hang its awaiter.
      console.warn('Terrain tile worker error', err);
      for (const resolve of slot.jobs.values()) resolve({ elev: null, mips: null });
      slot.jobs.clear();
    };
    workers.push(slot);
  }
  return workers;
}

/**
 * Resolves to { elev: {heights, width, height, border?} | {error} | null, mips: (ImageBitmap | { width, height, pieces })[] | null }
 * (aerial mip chain, full size down to 1x1).
 * `elevation` false skips the elevation fetch; `elevationBorder` adds that
 * many pixels from the neighbouring tiles around it (see sampleHeight);
 * `aerialBoost` null skips imagery. `detail` {widthMeters, heightMeters, cells,
 * heightOffset, skirtDepth, roadBed} also resolves `surface` (detailSurface.js), with
 * `elev` reduced to {ok} | {error}. Aborting `signal` resolves {aborted: true}.
 */
export function loadTileData({ z, x, y, elevation = true, elevationBorder = 0, aerialBoost = null, detail = null, signal = null }) {
  const id = nextId++;
  const slot = getWorkers().reduce((best, s) => (s.jobs.size < best.jobs.size ? s : best));
  return new Promise((resolve) => {
    slot.jobs.set(id, resolve);
    slot.worker.postMessage({ id, z, x, y, elevation, elevationBorder, aerialBoost, detail });
    signal?.addEventListener('abort', () => slot.jobs.has(id) && slot.worker.postMessage({ cancel: id }), { once: true });
  });
}
