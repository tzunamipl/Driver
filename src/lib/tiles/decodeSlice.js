// One decode slice per frame, shared by every vector tile decode (overlays, buildings),
// so a burst of arriving tiles spreads over frames instead of freezing one.

const DECODE_TIME_BUDGET_MS = 3; // per frame
export const DECODE_CHECK_INTERVAL = 16; // features between waitForDecodeSlice() calls

let decodeSliceEnd = 0;
let nextFramePromise = null;
let rushing = 0; // loads in progress that the game waits on (nothing to stutter)
function nextDecodeSlice() {
  nextFramePromise ??= new Promise((resolve) =>
    requestAnimationFrame(() => {
      nextFramePromise = null;
      decodeSliceEnd = performance.now() + DECODE_TIME_BUDGET_MS;
      resolve();
    })
  );
  return nextFramePromise;
}

/** Resolves at once while this frame's slice lasts (or during a rush), else at the start of the next one. */
export async function waitForDecodeSlice() {
  while (!rushing && performance.now() >= decodeSliceEnd) await nextDecodeSlice();
}

/** Decodes run unsliced until `promise` settles: for loads behind a loading screen or teleport. */
export function rushDecodesUntil(promise) {
  rushing++;
  promise.finally(() => rushing--);
  return promise;
}
