// Debug (?profile in the URL): logs every frame over HITCH_MS with where the time went -
// main-loop sections, streaming tasks, time between frames (async callbacks: tile decodes,
// worker results, GC) and GPU resources created (texture uploads, shader compiles).

const HITCH_MS = 50;
const SECTION_MIN_MS = 1; // smaller sections are left out of the log

export const PROFILE_ENABLED = new URLSearchParams(location.search).has('profile');

const NOOP = { begin() {}, mark() {}, end() {} };

export function createHitchProfiler(renderer) {
  if (!PROFILE_ENABLED) return NOOP;
  const sections = new Map();
  let frameStart = 0;
  let lastMark = 0;
  let prevEnd = 0;
  let longTasks = [];
  let prevResources = null;
  // The browser stops frames for a hidden tab: that gap isn't a hitch.
  let wasHidden = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) wasHidden = true;
  });
  try {
    // Chrome only: long tasks, ours or async, with their durations.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
    }).observe({ type: 'longtask' });
  } catch {
    // unsupported
  }

  function resources() {
    const { memory, programs } = renderer.info;
    return { textures: memory.textures, geometries: memory.geometries, programs: programs?.length ?? 0 };
  }

  return {
    begin() {
      frameStart = lastMark = performance.now();
      sections.clear();
    },

    /** Charges the time since the previous mark (or begin) to `name`. */
    mark(name) {
      const now = performance.now();
      sections.set(name, (sections.get(name) ?? 0) + now - lastMark);
      lastMark = now;
    },

    end() {
      const now = performance.now();
      const inFrame = now - frameStart;
      const between = prevEnd && !wasHidden ? frameStart - prevEnd : 0;
      prevEnd = now;
      wasHidden = false;
      const res = resources();
      const created = prevResources
        ? Object.entries(res)
            .map(([key, n]) => [key, n - prevResources[key]])
            .filter(([, d]) => d > 0)
        : [];
      prevResources = res;
      const tasks = longTasks;
      longTasks = [];
      if (inFrame + between < HITCH_MS) return;

      const top = [...sections]
        .filter(([, ms]) => ms >= SECTION_MIN_MS)
        .sort((a, b) => b[1] - a[1])
        .map(([name, ms]) => `${name} ${ms.toFixed(1)}`)
        .join(' · ');
      console.warn(
        `Hitch ${(inFrame + between).toFixed(0)} ms (in frame ${inFrame.toFixed(0)}, between frames ${between.toFixed(0)}): ${top || '-'}` +
          (created.length ? ` | new ${created.map(([key, d]) => `${key} +${d}`).join(', ')}` : '') +
          (tasks.length ? ` | long tasks ${tasks.join(', ')} ms` : '')
      );
    },
  };
}
