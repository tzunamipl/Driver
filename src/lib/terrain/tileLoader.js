// Main-thread side of tileWorker.js: one shared worker, replies matched by job id.

let worker = null;
let nextId = 1;
const jobs = new Map(); // id -> resolve

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const resolve = jobs.get(data.id);
    jobs.delete(data.id);
    resolve?.(data);
  };
  worker.onerror = (err) => {
    // Fail every outstanding job rather than hang its awaiter.
    console.warn('Terrain tile worker error', err);
    for (const resolve of jobs.values()) resolve({ elev: null, bitmap: null });
    jobs.clear();
  };
  return worker;
}

/**
 * Resolves to { elev: {heights, width, height, border?} | {error} | null, bitmap: ImageBitmap | null }.
 * `elevation` false skips the elevation fetch; `elevationBorder` adds that
 * many pixels from the neighbour tiles around it (see sampleHeight);
 * `aerialBoost` null skips imagery. `detail` {widthMeters, heightMeters, cells,
 * heightOffset, skirtDepth} also resolves `surface` (detailSurface.js), with
 * `elev` reduced to {ok} | {error}.
 */
export function loadTileData({ z, x, y, elevation = true, elevationBorder = 0, aerialBoost = null, detail = null }) {
  const id = nextId++;
  return new Promise((resolve) => {
    jobs.set(id, resolve);
    getWorker().postMessage({ id, z, x, y, elevation, elevationBorder, aerialBoost, detail });
  });
}
