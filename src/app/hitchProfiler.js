// Debug (?profile in the URL): logs every frame over HITCH_MS with where the time went -
// main-loop sections, streaming tasks, time between frames (async callbacks: tile decodes,
// worker results, GC) and GPU resources created (texture uploads, shader compiles).
// Chrome also names the scripts behind it (Long Animation Frames API).

const HITCH_MS = 150;
const SECTION_MIN_MS = 1; // smaller sections are left out of the log
const SCRIPT_MIN_MS = 5;
const MAX_SCRIPTS = 5;
// Observer entries for a frame arrive after it's painted: wait for them before logging.
const REPORT_DELAY_MS = 200;

export const PROFILE_ENABLED = new URLSearchParams(location.search).has('profile');

const NOOP = { begin() {}, mark() {}, end() {} };

export function createHitchProfiler(renderer) {
  if (!PROFILE_ENABLED) return NOOP;
  const sections = new Map();
  let frameStart = 0;
  let lastMark = 0;
  let prevEnd = 0;
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
  for (const [type, onEntry] of [
    ['longtask', (e) => longTasks.push(e)],
    ['long-animation-frame', (e) => scripts.push(...e.scripts)],
  ]) {
    try {
      const observer = new PerformanceObserver((list) => list.getEntries().forEach(onEntry));
      observer.observe({ type });
      observers.push([observer, onEntry]);
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

  function report(message, from, to) {
    setTimeout(() => {
      flushObservers();
      const cutoff = performance.now() - 10_000;
      const tasks = takeOverlapping(longTasks, from, to, cutoff);
      const top = takeOverlapping(scripts, from, to, cutoff)
        .filter((s) => s.duration >= SCRIPT_MIN_MS)
        .sort((a, b) => b.duration - a.duration)
        .slice(0, MAX_SCRIPTS);
      console.warn(
        message +
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
        now
      );
    },
  };
}
