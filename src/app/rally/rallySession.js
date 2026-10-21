// Rally game mode: picks a stage or rally from a scenario source, then runs its items in
// order. A stage item is a stageRun.js; a point item (service park, regroup, ...) is a
// liaison checkpoint to drive through, routed by the Navigation tab. Teleport and
// navigation are blocked while a stage is live; R rocks the car instead of resetting it.
// Progress (item, results) lives in the rally save slot; a stage cut off mid-run restarts.

import * as CANNON from 'cannon-es';
import { RALLY_BEST_STORAGE_KEY } from '../../config.js';
import { readSaveField, writeSaveField } from '../../lib/saves.js';
import { parseSource, openSource } from '../../lib/scenarios/source.js';
import { rallyFormat } from '../../lib/scenarios/rally.js';
import { snapToRoad, walkRoad } from '../../lib/scenarios/roadSnap.js';
import { createControlScenery } from '../../lib/rally/controlScenery.js';
import { createRallyHud, formatTime, formatDelta } from '../../hud/rallyHud.js';
import { createStageRun } from './stageRun.js';
import { createCarRocking } from '../carRocking.js';

const SPAWN_BACK_M = 120; // spawn this far before a stage's first point, along the road
const SPAWN_DROP_M = 1.5;
const LIAISON_PASS_PAD_M = 3; // liaison point passed within its half width + this
const ROUTE_MIN_M = 250; // closer targets aren't worth a navigation route
const JUMP_GUARD_M = 50; // a step moving the car further (teleport, reset) checks nothing
const SPLIT_SHOW_S = 5;
const GO_SHOW_S = 1.5;
const NEAR_ZONE_M = 80;

const stageKind = rallyFormat.kinds.find((k) => k.id === 'stage');
const rallyKind = rallyFormat.kinds.find((k) => k.id === 'rally');
const pointLabel = (type) => rallyFormat.pointTypes[type]?.label ?? type;

function readBest() {
  try {
    return JSON.parse(localStorage.getItem(RALLY_BEST_STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function writeBest(all) {
  try {
    localStorage.setItem(RALLY_BEST_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: bests last this session only.
  }
}

/** Stage file -> { id, name, points }. */
function readStage(json, id = json.id) {
  const { name, items } = stageKind.fromFile(json);
  return { id, name, points: items };
}

/** Plan items for a picked file: stage -> one stage item; rally -> its itinerary. */
async function buildPlan(kind, source, opened, json) {
  if (kind === 'stage') {
    const stage = readStage(json);
    return { kind, source, id: json.id, name: stage.name, items: [{ type: 'stage', stage }] };
  }
  const rally = rallyKind.fromFile(json);
  const stages = new Map();
  const items = [];
  for (const item of rally.items) {
    if (item.type === 'base') continue;
    if (item.type !== 'ref') {
      items.push({ type: 'point', point: item });
      continue;
    }
    if (!stages.has(item.ref)) {
      const stageJson = await opened.readJson(`${rallyFormat.folder}/${stageKind.folder}/${item.ref}.json`);
      if (!stageJson) throw new Error(`Stage ${item.ref} is missing from ${source}`);
      stages.set(item.ref, readStage(stageJson, item.ref));
    }
    const stage = stages.get(item.ref);
    items.push({ type: 'stage', stage: { ...stage, name: item.name || stage.name } });
  }
  return { kind, source, id: json.id, name: rally.name, items };
}

/** Points of a plan item, in driving order. */
const itemPoints = (item) => (item?.type === 'stage' ? item.stage.points : item ? [item.point] : []);

/**
 * Asks for the car and a stage / rally (the kind the game was started with) and loads it.
 * Needs no world, so the first pick happens before anything streams.
 * @returns {Promise<{plan: object, vehicleId: string}>}
 */
export async function pickPlan(picker, { vehicleId } = {}) {
  const kind = readSaveField('start') === 'rally' ? 'rally' : 'stage';
  const def = kind === 'rally' ? rallyKind : stageKind;
  const picked = await picker.pick({
    title: kind === 'rally' ? 'Choose a rally' : 'Choose a stage',
    folder: rallyFormat.folder,
    kind: def,
    vehicleId,
  });
  return { plan: await buildPlan(kind, picked.source, picked.opened, picked.json), vehicleId: picked.vehicleId };
}

/** Where a plan starts: its first item's first point (lat/lon), or null. */
export const planStart = (plan) => itemPoints(plan?.items[0])[0] ?? null;

/**
 * @param {object} deps
 * @param {{plan: object, vehicleId: string} | null} deps.initialPick - picked before the world loaded around it.
 * @param {() => string} deps.getVehicleId
 * @param {(vehicleId: string) => void} deps.switchVehicle
 * @param {() => void} deps.parkCar - pulls the handbrake once the car is placed at a stage.
 * @param {boolean} deps.keepsProgress - false: nothing but the car pick survives a reload.
 * @param {() => void} [deps.onSparkle] - sound when a control throws sparkles.
 * @param {(long: boolean) => void} [deps.onStartBeep] - timing beep: short (countdown light, check-in), long (GO, finish).
 */
export function createRallySession({ scene, streets, terrain, viewFrame, carManager, addressSearch, routeGuidance, picker, initialPick, getVehicleId, switchVehicle, parkCar, keepsProgress, onSparkle, onStartBeep }) {
  const scenery = createControlScenery({ scene, streets, terrain, viewFrame, onSparkle });
  const rocking = createCarRocking();
  let plan = null;
  let itemIndex = 0;
  let results = []; // { name, ms | null (DNF) }
  let run = null;
  let finished = false;
  let busy = false; // picking / loading / spawning
  let prev = null; // car world position after the last step
  let simTime = 0;
  let flash = null; // { text, until } short status after a split / GO
  let resultRows = null; // stable array for the HUD while unchanged
  const step = { x: 0, z: 0 };
  let shownRed = 0; // countdown lights already beeped for

  const hud = createRallyHud({
    retire: () => run?.retire(),
    restart: () => restartStage(),
    pick: () => choose(),
    newRally: () => choose(),
    pickAgain: () => choose(),
  });

  const isLive = () => !!run?.isLive();
  addressSearch.setBlocked(isLive);
  routeGuidance.setBlocked(isLive);

  const currentItem = () => plan?.items[itemIndex] ?? null;
  const bestKey = (stage) => `${plan.source}|${stage.id}`;

  function saveProgress(stageStarted = false) {
    if (!keepsProgress) return;
    if (!plan) return writeSaveField('rallyProgress', null);
    writeSaveField('rallyProgress', { kind: plan.kind, source: plan.source, id: plan.id, itemIndex, results, stageStarted });
  }

  function carPosition() {
    return carManager.getVehicle()?.chassisBody.position ?? null;
  }

  /** Scenery for the current item and the next one, so a stage's boards show on the way to it. */
  function showItem() {
    const item = currentItem();
    const points = [...itemPoints(item), ...itemPoints(plan.items[itemIndex + 1])];
    scenery.setPoints(points);
    run = null;
    resultRows = null;
    if (item?.type === 'stage') {
      const best = readBest()[bestKey(item.stage)] ?? null;
      run = createStageRun({ points: item.stage.points, getGate: scenery.getGate, best, onEvent: (e) => onStageEvent(item.stage, best, e) });
    }
    routeToItem();
  }

  function routeToItem() {
    const target = itemPoints(currentItem())[0];
    const pos = carPosition();
    if (!target || !pos || plan.kind === 'stage') return;
    const { x, z } = viewFrame.fromLatLon(target.lat, target.lon);
    if (Math.hypot(x - pos.x, z - pos.z) > ROUTE_MIN_M) routeGuidance.start({ lat: target.lat, lon: target.lon, label: pointLabel(target.type) });
  }

  function onStageEvent(stage, best, event) {
    if (event.type === 'countdown') saveProgress(true);
    // Timing clock beeps: check-in at a time / stop control, and the clock stopping at the finish.
    if (event.type === 'checkIn') onStartBeep?.(false);
    if (event.type === 'finish') onStartBeep?.(true);
    if (event.type === 'go') {
      flash = { text: 'GO!', until: simTime + GO_SHOW_S };
      onStartBeep?.(true);
    }
    if (event.type === 'passageControl') {
      scenery.sparkle(event.index);
      flash = { text: 'Passage control ✓', until: simTime + SPLIT_SHOW_S };
    }
    if (event.type === 'split') {
      scenery.celebrate(event.index);
      scenery.sparkle(event.index);
      const n = run.state.splits.length;
      const delta = run.lastSplitDelta();
      flash = { text: `Split ${n}: ${formatTime(event.ms)}${delta == null ? '' : `  ${formatDelta(delta)}`}`, until: simTime + SPLIT_SHOW_S };
    }
    if (event.type === 'jumpStart') flash = { text: 'Jump start! +10 s', until: simTime + SPLIT_SHOW_S };
    if (event.type === 'done') {
      const all = readBest();
      if (!all[bestKey(stage)] || event.ms < all[bestKey(stage)].totalMs) {
        all[bestKey(stage)] = { totalMs: event.ms, splits: run.state.splits };
        writeBest(all);
      }
      itemDone({ name: stage.name, ms: event.ms, splits: run.state.splits, penaltyMs: run.penaltyMs(), best });
    }
    if (event.type === 'retired') itemDone({ name: stage.name, ms: null, splits: run.state.splits, penaltyMs: 0, best });
  }

  function itemDone(result) {
    if (result) results = [...results, result];
    itemIndex++;
    if (itemIndex >= plan.items.length) {
      finished = true;
      resultRows = null;
      saveProgress();
      return;
    }
    saveProgress();
    showItem();
  }

  /** Puts the car just before the item's first point, facing along the road towards it; teleports there first unless the world is already loaded around it. */
  async function spawnAt(index, teleport = true) {
    const points = itemPoints(plan.items[index]);
    const first = points[0];
    if (!first) return;
    if (teleport && !(await addressSearch.teleport(first.lat, first.lon, plan.name))) return;
    const at = viewFrame.fromLatLon(first.lat, first.lon);
    const next = points[1] ? viewFrame.fromLatLon(points[1].lat, points[1].lon) : null;
    const snap = snapToRoad(streets, at.x, at.z, 40);
    let pos = at;
    let dirX = next ? next.x - at.x : 0;
    let dirZ = next ? next.z - at.z : 1;
    if (snap) {
      const sign = snap.dirX * dirX + snap.dirZ * dirZ >= 0 ? 1 : -1;
      const back = walkRoad(streets, snap, -SPAWN_BACK_M * sign);
      pos = back;
      // Walked backwards: travel is the other way.
      dirX = -back.dirX;
      dirZ = -back.dirZ;
    }
    const y = (terrain.surfaceHeightAt(pos.x, pos.z) ?? 0) + SPAWN_DROP_M;
    const quat = new CANNON.Quaternion();
    // Chassis forward is local +z.
    quat.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.atan2(dirX, dirZ));
    carManager.getReset()?.(new CANNON.Vec3(pos.x, y, pos.z), quat);
    parkCar();
    prev = null;
  }

  /** @param {'teleport' | 'place' | null} spawn - how to bring the car to the item, if at all. */
  async function startPlan(newPlan, index = 0, previousResults = [], spawn = 'teleport') {
    plan = newPlan;
    itemIndex = index;
    results = previousResults;
    finished = itemIndex >= plan.items.length;
    if (finished) return;
    saveProgress();
    showItem();
    if (spawn) await spawnAt(itemIndex, spawn === 'teleport');
    routeToItem();
  }

  async function choose() {
    if (busy) return;
    busy = true;
    try {
      routeGuidance.stop();
      scenery.clear();
      plan = null;
      run = null;
      finished = false;
      saveProgress();
      const picked = await pickPlan(picker, { vehicleId: getVehicleId() });
      if (picked.vehicleId !== getVehicleId()) switchVehicle(picked.vehicleId);
      await startPlan(picked.plan);
    } catch (err) {
      console.warn('Rally:', err);
      plan = null;
      run = null;
      flash = { text: err.message, until: simTime + SPLIT_SHOW_S };
    } finally {
      busy = false;
    }
  }

  async function restartStage() {
    if (busy || !plan) return;
    busy = true;
    try {
      // Single stage: a fresh run; rally: the current stage again.
      const index = plan.kind === 'stage' ? 0 : itemIndex;
      await startPlan(plan, index, plan.kind === 'stage' ? [] : results);
    } finally {
      busy = false;
    }
  }

  function stageView(item) {
    const stage = item.stage;
    const ss = plan.items.slice(0, itemIndex + 1).filter((i) => i.type === 'stage').length;
    const { state } = run;
    const next = item.stage.points[state.next];
    const gate = next && scenery.getGate(state.next);
    const pos = carPosition();
    const dist = gate && pos ? Math.hypot(gate.x - pos.x, gate.z - pos.z) : null;
    let status = '';
    if (state.phase === 'approach') {
      const near = dist != null && dist < NEAR_ZONE_M;
      status = next?.type === 'start' ? 'Stop at the start line' : near ? `Stop in the ${pointLabel(next?.type).toLowerCase()} zone` : `Drive to the ${pointLabel(next?.type).toLowerCase()}`;
    } else if (state.phase === 'countdown') status = 'Get ready…';
    else if (state.phase === 'afterFinish') status = 'Stop in the stop control zone';
    if (flash && simTime < flash.until) status = flash.text;
    return {
      title: `SS${ss} · ${stage.name}`,
      clockMs: state.startTime == null ? (state.phase === 'countdown' ? 0 : null) : run.elapsedMs(),
      lights: state.phase === 'countdown' || run.lights().green ? run.lights() : null,
      status,
      next: next && dist != null && state.phase !== 'countdown' ? `Next: ${pointLabel(next.type)} · ${Math.round(dist)} m` : '',
      penaltyMs: run.penaltyMs(),
      buttons: run.isLive() ? ['retire'] : [],
    };
  }

  function resultsView() {
    if (!resultRows) {
      const rows = [];
      if (plan.kind === 'stage') {
        const r = results[results.length - 1];
        r?.splits.forEach((ms, i) => {
          const best = r.best?.splits?.[i];
          rows.push([`Split ${i + 1}`, `${formatTime(ms)}${best != null ? `  ${formatDelta(ms - best)}` : ''}`]);
        });
        if (r?.penaltyMs) rows.push(['Penalty', `+${formatTime(r.penaltyMs)}`]);
        rows.push(['Stage time', r?.ms == null ? 'DNF' : formatTime(r.ms)]);
        if (r?.best) rows.push(['Best', formatTime(r.best.totalMs)]);
        else if (r?.ms != null) rows.push(['Best', 'New best!']);
      } else {
        for (const r of results) rows.push([r.name, r.ms == null ? 'DNF' : formatTime(r.ms)]);
        const dnf = results.some((r) => r.ms == null);
        rows.push(['Total', dnf ? 'DNF' : formatTime(results.reduce((sum, r) => sum + r.ms, 0))]);
      }
      resultRows = rows;
    }
    return {
      title: plan.kind === 'stage' ? `${plan.name} · finished` : `${plan.name} · rally finished`,
      results: resultRows,
      buttons: plan.kind === 'stage' ? ['restart', 'pick'] : ['newRally'],
    };
  }

  function view() {
    if (!plan && busy) return { title: 'Rally', status: 'Choose a stage or rally' };
    // Loading failed: say why, and offer the picker again.
    if (!plan) return { title: 'Rally', status: flash?.text ?? '', buttons: ['pickAgain'] };
    if (finished) return resultsView();
    const item = currentItem();
    if (item.type === 'stage') return stageView(item);
    const gate = scenery.getGate(0);
    const pos = carPosition();
    const dist = gate && pos ? Math.round(Math.hypot(gate.x - pos.x, gate.z - pos.z)) : null;
    return {
      title: plan.name,
      status: flash && simTime < flash.until ? flash.text : `Liaison: drive to ${pointLabel(item.point.type).toLowerCase()}`,
      next: dist == null ? '' : `${pointLabel(item.point.type)} · ${dist} m`,
    };
  }

  return {
    /** After joining: resume saved progress, else pick a stage / rally. */
    async begin() {
      if (initialPick) {
        busy = true;
        try {
          await startPlan(initialPick.plan, 0, [], 'place');
        } finally {
          busy = false;
        }
        return;
      }
      const progress = keepsProgress ? readSaveField('rallyProgress') : null;
      const source = parseSource(progress?.source);
      if (!progress || !source) return choose();
      busy = true;
      let resumed = false;
      try {
        const opened = await openSource(source);
        const def = progress.kind === 'rally' ? rallyKind : stageKind;
        const json = await opened.readJson(`${rallyFormat.folder}/${def.folder}/${progress.id}.json`);
        if (!json) throw new Error(`${progress.id} is gone from ${progress.source}`);
        const saved = await buildPlan(progress.kind, progress.source, opened, json);
        // A stage cut off mid-run starts over from its beginning.
        await startPlan(saved, progress.itemIndex ?? 0, progress.results ?? [], progress.stageStarted ? 'teleport' : null);
        resumed = true;
      } catch (err) {
        console.warn('Rally: could not resume', err);
      } finally {
        busy = false;
      }
      if (!resumed) await choose();
    },

    /** R key: rock the car (no reset in rally). */
    rock() {
      rocking.rock(carManager.getVehicle(), simTime);
    },

    /** Per physics step: timing and checkpoints. */
    afterStep(dt) {
      simTime += dt;
      const pos = carPosition();
      if (!pos || !plan || finished || busy) return;
      step.x = pos.x;
      step.z = pos.z;
      if (!prev || Math.hypot(step.x - prev.x, step.z - prev.z) > JUMP_GUARD_M) {
        prev = { x: step.x, z: step.z };
        return;
      }
      const item = currentItem();
      if (item.type === 'stage') {
        run.step(dt, prev, step, carManager.getVehicle().chassisBody.velocity.length());
      } else {
        const gate = scenery.getGate(0);
        if (gate && Math.hypot(step.x - gate.x, step.z - gate.z) < gate.halfWidth + LIAISON_PASS_PAD_M) {
          flash = { text: `${pointLabel(item.point.type)} ✓`, until: simTime + SPLIT_SHOW_S };
          itemDone(null);
        }
      }
      prev.x = step.x;
      prev.z = step.z;
    },

    /** Per frame: scenery, start lights, HUD. */
    update(dt) {
      scenery.update(dt);
      if (run && run.startIndex >= 0) {
        const { red, green } = run.lights();
        scenery.setLights(run.startIndex, red, green);
        // A beep as each countdown light comes on.
        if (red > shownRed) onStartBeep?.(false);
        shownRed = red;
      }
      hud.render(view());
    },

    shiftOrigin(dx, dz) {
      scenery.shiftOrigin(dx, dz);
      if (prev) {
        prev.x -= dx;
        prev.z -= dz;
      }
    },
  };
}
