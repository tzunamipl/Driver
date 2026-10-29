// Debug (?profile in the URL): logs every frame over HITCH_MS with where the time went -
// main-loop sections, streaming tasks, time between frames (async callbacks: tile decodes,
// worker results, GC) and GPU resources created (texture uploads, shader compiles).
// Chrome also names the scripts behind it (Long Animation Frames API). GPU time per frame where
// EXT_disjoint_timer_query_webgl2 exists (not Safari); "idle" = time between frames no long task covers
// (the GPU or compositor holding the next frame back, when the GPU numbers are high).
// "main thread stalled" = longest gap in a 10 ms timer heartbeat (any browser): JS / GC blocked it;
// a big idle with a small stall = the main thread was free and the GPU process / compositor / OS held the frame.

const HITCH_MS = 150;
const SECTION_MIN_MS = 1; // smaller sections are left out of the log
const SCRIPT_MIN_MS = 5;
const MAX_SCRIPTS = 5;
// Observer entries for a frame arrive after it's painted: wait for them before logging.
const REPORT_DELAY_MS = 200;
const GPU_FRAMES_KEPT = 120; // per-frame GPU times kept for the delayed report
const TICK_MS = 10;

export const PROFILE_ENABLED = new URLSearchParams(location.search).has('profile');

const NOOP = { begin() {}, mark() {}, end() {} };

export function createHitchProfiler(renderer) {
  if (!PROFILE_ENABLED) return NOOP;
  const sections = new Map();
  let frameStart = 0;
  let lastMark = 0;
  let prevEnd = 0;
  let frame = 0;
  const gpu = createGpuTimer(renderer);
  const observers = [];
  let prevResources = null;
  let seenPrograms = new Set();
  // The browser stops frames for a hidden tab: that gap isn't a hitch.
  let wasHidden = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) wasHidden = true;
  });
  // Chrome only: long tasks, and long animation frames with the scripts that ran in them.
  const longTasks = [];
  const scripts = [];
  let hasLongTasks = false;
  const ticks = [];
  setInterval(() => ticks.push(performance.now()), TICK_MS);
  for (const [type, onEntry] of [
    ['longtask', (e) => longTasks.push(e)],
    ['long-animation-frame', (e) => scripts.push(...e.scripts)],
  ]) {
    try {
      const observer = new PerformanceObserver((list) => list.getEntries().forEach(onEntry));
      observer.observe({ type });
      observers.push([observer, onEntry]);
      if (type === 'longtask') hasLongTasks = true;
    } catch {
      // unsupported
    }
  }

  function flushObservers() {
    for (const [observer, onEntry] of observers) observer.takeRecords().forEach(onEntry);
  }

  /** Drops entries that ended before `t`, returns those overlapping [from, to]. */
  function takeOverlapping(list, from, to, t) {
    const kept = list.filter((e) => e.startTime + e.duration >= t);
    list.length = 0;
    list.push(...kept);
    return kept.filter((e) => e.startTime <= to && e.startTime + e.duration >= from);
  }

  function scriptLabel(s) {
    const where = s.sourceURL ? `${s.sourceURL.split('/').pop().split('?')[0]}:${s.sourceCharPosition}` : '';
    const what = s.sourceFunctionName || s.invoker || s.invokerType;
    return `${what}${where ? ` @${where}` : ''} ${Math.round(s.duration)}`;
  }

  /** Longest stretch of [from, to] without a heartbeat tick; drops ticks before `cutoff`. */
  function longestStall(from, to, cutoff) {
    while (ticks.length && ticks[0] < cutoff) ticks.shift();
    let prev = from;
    let longest = 0;
    for (const t of ticks) {
      if (t <= from) continue;
      longest = Math.max(longest, Math.min(t, to) - prev);
      prev = t;
      if (t >= to) break;
    }
    return Math.max(longest, to - prev);
  }

  /** Long-task time inside [from, to]. */
  function coveredMs(tasks, from, to) {
    return tasks.reduce((sum, e) => sum + Math.max(0, Math.min(to, e.startTime + e.duration) - Math.max(from, e.startTime)), 0);
  }

  function report(message, from, to, gap, frameId) {
    setTimeout(() => {
      flushObservers();
      gpu?.poll();
      const cutoff = performance.now() - 10_000;
      const tasks = takeOverlapping(longTasks, from, to, cutoff);
      const idle = gap ? gap.to - gap.from - coveredMs(tasks, gap.from, gap.to) : 0;
      const stall = gap ? longestStall(gap.from, gap.to, cutoff) : 0;
      const gpuMs = gpu?.frameMs(frameId);
      const gpuPrev = gpu?.frameMs(frameId - 1);
      const top = takeOverlapping(scripts, from, to, cutoff)
        .filter((s) => s.duration >= SCRIPT_MIN_MS)
        .sort((a, b) => b.duration - a.duration)
        .slice(0, MAX_SCRIPTS);
      console.warn(
        message +
          (gpu ? ` | gpu ${gpuMs?.toFixed(1) ?? '?'} (frame before ${gpuPrev?.toFixed(1) ?? '?'})` : '') +
          (idle >= SECTION_MIN_MS ? ` | ${hasLongTasks ? 'idle' : 'unattributed (no long-task API)'} ${Math.round(idle)} ms` : '') +
          (gap ? ` | main thread stalled ${Math.round(stall)} ms` : '') +
          (tasks.length ? ` | long tasks ${tasks.map((e) => Math.round(e.duration)).join(', ')} ms` : '') +
          (top.length ? ` | scripts ${top.map(scriptLabel).join(' · ')}` : '')
      );
    }, REPORT_DELAY_MS);
  }

  // Material type, plus a short customProgramCacheKey (the cache key's last part; three's default is the onBeforeCompile source).
  function programLabel(program) {
    const custom = program.cacheKey?.split(',').pop();
    return /^[\w-]{1,40}$/.test(custom ?? '') ? `${program.name} ${custom}` : program.name;
  }

  function resources() {
    const { memory, programs } = renderer.info;
    return { textures: memory.textures, geometries: memory.geometries, programs: programs?.length ?? 0 };
  }

  return {
    begin() {
      frameStart = lastMark = performance.now();
      sections.clear();
      gpu?.begin(++frame);
    },

    /** Charges the time since the previous mark (or begin) to `name`. */
    mark(name) {
      const now = performance.now();
      sections.set(name, (sections.get(name) ?? 0) + now - lastMark);
      lastMark = now;
    },

    end() {
      gpu?.end();
      gpu?.poll();
      const now = performance.now();
      const inFrame = now - frameStart;
      const between = prevEnd && !wasHidden ? frameStart - prevEnd : 0;
      const gap = between ? { from: prevEnd, to: frameStart } : null;
      const windowStart = prevEnd || frameStart;
      prevEnd = now;
      wasHidden = false;
      const res = resources();
      const created = prevResources
        ? Object.entries(res)
            .map(([key, n]) => [key, n - prevResources[key]])
            .filter(([, d]) => d > 0)
        : [];
      prevResources = res;
      const programs = renderer.info.programs ?? [];
      const newPrograms = created.length ? programs.filter((p) => !seenPrograms.has(p)) : [];
      seenPrograms = new Set(programs);
      if (inFrame + between < HITCH_MS) return;

      const top = [...sections]
        .filter(([, ms]) => ms >= SECTION_MIN_MS)
        .sort((a, b) => b[1] - a[1])
        .map(([name, ms]) => `${name} ${ms.toFixed(1)}`)
        .join(' · ');
      report(
        `Hitch ${(inFrame + between).toFixed(0)} ms (in frame ${inFrame.toFixed(0)}, between frames ${between.toFixed(0)}): ${top || '-'}` +
          (created.length ? ` | new ${created.map(([key, d]) => `${key} +${d}`).join(', ')}` : '') +
          (newPrograms.length ? ` (${newPrograms.map(programLabel).join(', ')})` : ''),
        windowStart,
        now,
        gap,
        frame
      );
    },
  };
}

/**
 * GPU time of each frame (begin..end) from WebGL2 timer queries, read back once the GPU is done (a few frames on);
 * null where the extension is missing. Frames the GPU was disjointed in (power state, context switch) stay unknown.
 */
function createGpuTimer(renderer) {
  const gl = renderer.getContext();
  const ext = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  if (!ext) return null;
  const pending = []; // [frame id, query], oldest first
  const times = new Map(); // frame id -> ms
  let active = null;
  return {
    begin(frameId) {
      if (active) return;
      const query = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      active = [frameId, query];
    },
    end() {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(active);
      active = null;
    },
    poll() {
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      while (pending.length && gl.getQueryParameter(pending[0][1], gl.QUERY_RESULT_AVAILABLE)) {
        const [frameId, query] = pending.shift();
        if (!disjoint) times.set(frameId, gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(query);
      }
      for (const id of times.keys()) {
        if (times.size <= GPU_FRAMES_KEPT) break;
        times.delete(id);
      }
    },
    frameMs(frameId) {
      return times.get(frameId);
    },
  };
}
