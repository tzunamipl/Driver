// One decode slice per frame, shared by every vector tile decode (overlays, buildings),
// so a burst of arriving tiles spreads over frames instead of freezing one.

const DECODE_TIME_BUDGET_MS = 3; // per frame
export const DECODE_CHECK_INTERVAL = 16; // features between waitForDecodeSlice() calls

let decodeSliceEnd = 0;
let nextFramePromise = null;
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

/** Resolves at once while this frame's slice lasts, else at the start of the next one. */
export async function waitForDecodeSlice() {
  while (performance.now() >= decodeSliceEnd) await nextDecodeSlice();
}
