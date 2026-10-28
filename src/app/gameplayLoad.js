// Gameplay tier of a load (after terrain): the overlay data behind tyre grip and
// splash, and the near buildings' collision prisms. Cosmetics stream in afterwards.

import { lon2tileX, lat2tileY } from '../lib/geo.js';
import { DETAIL_ZOOM } from '../lib/terrain.js';
import { rushDecodesUntil } from '../lib/tiles/decodeSlice.js';

// A slow data server shouldn't hold the game: past this it all keeps streaming in play.
const GAMEPLAY_LOAD_TIMEOUT_MS = 20_000;
// Per streamer and slice; between slices the loading screen / teleport status repaint.
const BUILD_SLICE_MS = 16;
const PROGRESS_POLL_MS = 150;

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Resolves once `layers` (overlay managers) hold data around (lat, lon) and `buildings` are built there, or on timeout.
 * `onProgress(fraction)` gets 0..1 (never decreasing): half for the downloads, half for the mesh builds.
 */
export function loadGameplayLayers({ buildings, layers }, lat, lon, onProgress = () => {}) {
  const tx = Math.floor(lon2tileX(lon, DETAIL_ZOOM));
  const ty = Math.floor(lat2tileY(lat, DETAIL_ZOOM));
  const streamers = [...layers, buildings];
  let dataReady = false;
  let stopped = false;
  let maxDownloads = 0;
  let maxBuilds = 0;
  let shown = 0;

  function report() {
    let downloads = 0;
    let builds = 0;
    for (const streamer of streamers) {
      const work = streamer.nearWork();
      downloads += work.downloads;
      builds += work.builds;
    }
    maxDownloads = Math.max(maxDownloads, downloads);
    maxBuilds = Math.max(maxBuilds, builds);
    const downloaded = dataReady ? 1 : maxDownloads ? 1 - downloads / maxDownloads : 0;
    const built = dataReady && !builds ? 1 : maxBuilds ? 1 - builds / maxBuilds : 0;
    shown = Math.max(shown, (downloaded + built) / 2);
    onProgress(shown);
  }

  async function load() {
    // Deadline 0: fetch and queue only; the builds run sliced below.
    await Promise.allSettled(streamers.map((streamer) => streamer.update(tx, ty, true, 0)));
    dataReady = true;
    for (;;) {
      let left = 0;
      for (const streamer of streamers) {
        if (!streamer.nearWork().builds) continue;
        await streamer.update(tx, ty, false, performance.now() + BUILD_SLICE_MS);
        left += streamer.nearWork().builds;
      }
      report();
      if (!left || stopped) return;
      await nextTask();
    }
  }

  report();
  const poll = setInterval(report, PROGRESS_POLL_MS);
  const timeout = new Promise((resolve) => setTimeout(resolve, GAMEPLAY_LOAD_TIMEOUT_MS));
  return rushDecodesUntil(Promise.race([load().catch((err) => console.warn('Gameplay layer load failed', err)), timeout])).finally(() => {
    stopped = true;
    clearInterval(poll);
    onProgress(1);
  });
}
