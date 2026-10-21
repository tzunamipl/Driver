// One run of a rally stage. Points are done strictly in order: time control and stop
// control by stopping in their zone, the start by stopping at the line for the 5-light
// countdown, splits / passage controls / finish by crossing their gate line. Time is
// simulation time (summed physics steps), with crossings interpolated inside the step.

const STOP_SPEED = 0.6; // m/s: counts as stopped
const ZONE_RADIUS_M = 15; // time control / stop control zone around the point
const START_BOX_M = 8; // stop within this of the start line, not past it
const COUNTDOWN_S = 5; // one light per second, GO after the fifth
const JUMP_START_M = 1; // moving this far before GO is a jump start
export const JUMP_START_PENALTY_MS = 10_000;
const PROXIMITY_PAD_M = 2; // gates without a known road direction: pass within half width + this

const STOP_KINDS = new Set(['timeControl', 'start', 'stop']);

/** Fraction (0..1) along p0->p1 where it crosses segment a->b, or null. */
function segmentCrossing(p0x, p0z, p1x, p1z, ax, az, bx, bz) {
  const rx = p1x - p0x;
  const rz = p1z - p0z;
  const sx = bx - ax;
  const sz = bz - az;
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const qx = ax - p0x;
  const qz = az - p0z;
  const t = (qx * sz - qz * sx) / denom;
  const u = (qx * rz - qz * rx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/**
 * @param {object} opts
 * @param {{type: string}[]} opts.points
 * @param {(i: number) => ({x: number, z: number, dirX: number | null, dirZ: number | null, halfWidth: number} | null)} opts.getGate
 *   - point i's gate in world metres (indices into `points`).
 * @param {{splits: number[], totalMs: number} | null} opts.best
 * @param {(event: {type: string, index: number, ms?: number}) => void} opts.onEvent
 */
export function createStageRun({ points, getGate, best, onEvent }) {
  const startIndex = points.findIndex((p) => p.type === 'start');
  const state = {
    phase: 'approach', // approach -> countdown -> running -> afterFinish -> done | retired
    next: 0,
    time: 0, // simulation seconds since the run began
    startTime: null,
    finishTime: null,
    countdownStart: null,
    countdownFrom: null,
    jumpStart: false,
    splits: [], // ms after the start, per split passed (passage controls aren't timed)
  };

  const penaltyMs = () => (state.jumpStart ? JUMP_START_PENALTY_MS : 0);
  const elapsedMs = () =>
    state.startTime == null ? 0 : Math.round(((state.finishTime ?? state.time) - state.startTime) * 1000);

  function advance() {
    state.next++;
    if (state.next >= points.length) {
      state.phase = 'done';
      onEvent({ type: 'done', index: points.length - 1, ms: elapsedMs() + penaltyMs() });
    }
  }

  function stoppedIn(gate, car, speed, radius) {
    return speed < STOP_SPEED && Math.hypot(car.x - gate.x, car.z - gate.z) < radius;
  }

  /** Crossing time within this step, as a fraction 0..1, or null. */
  function crossedAt(gate, prev, car) {
    if (gate.dirX == null) {
      return Math.hypot(car.x - gate.x, car.z - gate.z) < gate.halfWidth + PROXIMITY_PAD_M ? 1 : null;
    }
    // Gate line across the road: perpendicular to travel.
    const px = -gate.dirZ * gate.halfWidth;
    const pz = gate.dirX * gate.halfWidth;
    return segmentCrossing(prev.x, prev.z, car.x, car.z, gate.x - px, gate.z - pz, gate.x + px, gate.z + pz);
  }

  function handlePoint(type, gate, prev, car, speed, stepStart, dt) {
    if (type === 'start') {
      if (state.phase === 'countdown') return;
      // In the box: near the line and not past it.
      const along = gate.dirX == null ? 0 : (car.x - gate.x) * gate.dirX + (car.z - gate.z) * gate.dirZ;
      if (along <= 0.5 && stoppedIn(gate, car, speed, START_BOX_M)) {
        state.phase = 'countdown';
        state.countdownStart = state.time;
        state.countdownFrom = { x: car.x, z: car.z };
        onEvent({ type: 'countdown', index: state.next });
      }
      return;
    }
    if (STOP_KINDS.has(type)) {
      if (stoppedIn(gate, car, speed, Math.max(ZONE_RADIUS_M, gate.halfWidth + PROXIMITY_PAD_M))) {
        onEvent({ type: 'checkIn', index: state.next });
        advance();
      }
      return;
    }
    const t = crossedAt(gate, prev, car);
    if (t == null) return;
    const at = stepStart + t * dt;
    if (type === 'finish' && state.phase === 'running') {
      state.finishTime = at;
      state.phase = 'afterFinish';
      onEvent({ type: 'finish', index: state.next, ms: elapsedMs() });
    } else if (state.phase === 'running' && type === 'split') {
      const ms = Math.round((at - state.startTime) * 1000);
      state.splits.push(ms);
      onEvent({ type, index: state.next, ms });
    } else {
      onEvent({ type, index: state.next });
    }
    advance();
  }

  return {
    state,
    startIndex,
    penaltyMs,
    elapsedMs,
    /** True from the countdown to the stop control: no teleport or navigation. */
    isLive: () => state.phase === 'countdown' || state.phase === 'running' || state.phase === 'afterFinish',

    /** One physics step: `prev` / `car` = chassis world (x, z) before / after it, `speed` in m/s. */
    step(dt, prev, car, speed) {
      const stepStart = state.time;
      state.time += dt;
      if (state.phase === 'done' || state.phase === 'retired') return;

      if (state.phase === 'countdown') {
        if (!state.jumpStart && Math.hypot(car.x - state.countdownFrom.x, car.z - state.countdownFrom.z) > JUMP_START_M) {
          state.jumpStart = true;
          onEvent({ type: 'jumpStart', index: state.next });
        }
        if (state.time - state.countdownStart >= COUNTDOWN_S) {
          // The clock starts at GO, wherever the car is.
          state.startTime = state.countdownStart + COUNTDOWN_S;
          state.phase = 'running';
          onEvent({ type: 'go', index: state.next });
          advance();
        }
        return;
      }

      const gate = getGate(state.next);
      if (gate) handlePoint(points[state.next].type, gate, prev, car, speed, stepStart, dt);
    },

    /** Countdown lights: { red: 0..5, green }. */
    lights() {
      if (state.phase === 'countdown') return { red: Math.min(5, Math.floor(state.time - state.countdownStart) + 1), green: false };
      if (state.phase === 'running' && state.time - state.startTime < 1.5) return { red: 0, green: true };
      return { red: 0, green: false };
    },

    /** Delta (ms) of the latest split against the best run's same split, or null. */
    lastSplitDelta() {
      const i = state.splits.length - 1;
      return i >= 0 && best?.splits?.[i] != null ? state.splits[i] - best.splits[i] : null;
    },

    retire() {
      if (state.phase === 'done') return;
      state.phase = 'retired';
      onEvent({ type: 'retired', index: state.next });
    },
  };
}
