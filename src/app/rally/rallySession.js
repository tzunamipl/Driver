// Rally game mode: picks a stage or rally from a scenario source, then runs its items in
// order. A stage item is a stageRun.js; a point item (service park, regroup, ...) is a
// liaison checkpoint to drive through, routed by the Navigation tab. Teleport and
// navigation are blocked while a stage is live; R rocks the car instead of resetting it.
// Progress (item, results, the live stage's clock and controls) lives in the game's save slot,
// so a game left mid-stage resumes there with the car where it stood (lib/carState.js).

import * as CANNON from 'cannon-es';
import { OFFICIAL_SCENARIO_SOURCE } from '../../config.js';
import { leaderboardEnabled, submitStageTime } from '../../lib/leaderboard.js';
import { readSaveField, writeSaveField, getActiveStartId } from '../../lib/saves.js';
import { parseSource, openSource } from '../../lib/scenarios/source.js';
import { rallyFormat } from '../../lib/scenarios/rally.js';
import { filePath } from '../../lib/scenarios/paths.js';
import { controlFrame } from '../../lib/scenarios/roadSnap.js';
import { createControlScenery } from '../../lib/rally/controlScenery.js';
import { readLocalBests, writeLocalBests, localBestKey } from '../../lib/rally/localBest.js';
import { createRallyHud, formatTime, formatDelta } from '../../hud/rallyHud.js';
import { createRallyPlanHud } from '../../hud/rallyPlanHud.js';
import { createStageRun } from './stageRun.js';
import { createPacenoteRun } from './pacenoteRun.js';
import { createPacenoteHud } from '../../hud/pacenoteHud.js';
import { createCarRocking } from '../carRocking.js';
import { getVehicle } from '../../lib/vehicles/index.js';
import { getVehicleColor } from '../../lib/vehicleColors.js';
import { getTyreSetup } from '../../lib/garage.js';
import { sameTyreSetup } from '../../lib/tyres/setup.js';

const SPAWN_BACK_M = 120; // spawn this far before a stage's first point, along the road
const SPAWN_DROP_M = 1.5;
const LIAISON_PASS_PAD_M = 3; // liaison point passed within its half width + this
const LIAISON_STOP_ZONE_M = 15; // stop-type liaison points: stop within this
const LIAISON_STOP_SPEED = 0.6; // m/s: counts as stopped
const ROUTE_MIN_M = 250; // closer targets aren't worth a navigation route
const JUMP_GUARD_M = 50; // a step moving the car further (teleport, reset) checks nothing
const SPLIT_SHOW_S = 5;
const STAGE_DONE_SHOW_S = 10; // rally: a finished stage's time + world rank over the next item
const GO_SHOW_S = 1.5;
const NEAR_ZONE_M = 80;
const PROGRESS_SAVE_S = 1; // throttle for the live stage's clock, alongside the car state

const stageKind = rallyFormat.kinds.find((k) => k.id === 'stage');
const rallyKind = rallyFormat.kinds.find((k) => k.id === 'rally');
const pointLabel = (type) => rallyFormat.pointTypes[type]?.label ?? type;

/** Stage file -> { id (its file key), name, points, pacenotes }. */
function readStage(json, id) {
  const { name, items, pacenotes } = stageKind.fromFile(json);
  return { id, name, points: items, pacenotes };
}

/** Plan items for a picked file: stage -> one stage item; rally -> its itinerary. */
async function buildPlan(kind, source, opened, key, json) {
  if (kind === 'stage') {
    const stage = readStage(json, key);
    return { kind, source, sha: opened.sha, id: key, name: stage.name, items: [{ type: 'stage', stage }] };
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
      const stageJson = await opened.readJson(filePath(rallyFormat.folder, stageKind, item.ref));
      if (!stageJson) throw new Error(`Stage ${item.ref} is missing from ${source}`);
      stages.set(item.ref, readStage(stageJson, item.ref));
    }
    const stage = stages.get(item.ref);
    items.push({ type: 'stage', stage: { ...stage, name: item.name || stage.name } });
  }
  const base = rally.items.find((item) => item.type === 'base') ?? null;
  return { kind, source, sha: opened.sha, id: key, name: rally.name, base, items };
}

/** Points of a plan item, in driving order. */
const itemPoints = (item) => (item?.type === 'stage' ? item.stage.points : item ? [item.point] : []);

/**
 * Asks for the car and a stage / rally (the kind the game was started with) and loads it.
 * Needs no world, so the first pick happens before anything streams.
 * @returns {Promise<{plan: object, vehicleId: string} | null>} null on Back.
 */
export async function pickPlan(picker, { vehicleId } = {}) {
  const kind = getActiveStartId() === 'stage' ? 'stage' : 'rally';
  const def = kind === 'rally' ? rallyKind : stageKind;
  return picker.pick({
    title: kind === 'rally' ? 'Choose a rally' : 'Choose a stage',
    folder: rallyFormat.folder,
    kind: def,
    loadPlan: ({ source, opened, key, json }) => buildPlan(kind, source, opened, key, json),
    vehicleId,
  });
}

/** Where a plan starts: its first item's first point (lat/lon), or null. */
export const planStart = (plan) => itemPoints(plan?.items[0])[0] ?? null;

/**
 * @param {object} deps
 * @param {{plan: object, vehicleId: string} | null} deps.initialPick - picked before the world loaded around it.
 * @param {() => string} deps.getVehicleId
 * @param {(vehicleId: string) => void} deps.switchVehicle
 * @param {() => void} deps.parkCar - pulls the handbrake once the car is placed at a stage.
 * @param {() => void} [deps.onTyreService] - a tyre service point was passed (default: fresh tyres).
 * @param {boolean} deps.keepsProgress - false: nothing but the car pick survives a reload.
 * @param {string} deps.playerId - for the online leaderboard.
 * @param {() => string | null} deps.getPlayerName
 * @param {() => void} [deps.onSparkle] - sound when a control throws sparkles.
 * @param {(speed: number, spec: object) => void} [deps.onPropHit] - sound when the car knocks a flag / board / light over.
 * @param {(long: boolean) => void} [deps.onStartBeep] - timing beep: short (countdown light, check-in), long (GO, finish).
 * @param {() => number} [deps.getTimeOfDayMs] - simulated clock (epoch ms) for the control clocks.
 * @param {(points: object[]) => void} [deps.onMapPoints] - plan icons for the minimap / Navigation map (scenarioPointIcon.js).
 * @param {(held: boolean) => void} [deps.onFinishHold] - true while the finished plan's results are up (car parked, drone view).
 * @param {() => void} [deps.openMainMenu]
 */
export function createRallySession({ scene, world, streets, terrain, viewFrame, carManager, addressSearch, routeGuidance, picker, initialPick, getVehicleId, switchVehicle, parkCar, onTyreService, keepsProgress, playerId, getPlayerName, onSparkle, onPropHit, onStartBeep, getTimeOfDayMs, onMapPoints, onFinishHold, openMainMenu }) {
  const scenery = createControlScenery({ scene, world, streets, terrain, viewFrame, onSparkle, onHit: onPropHit, getTimeOfDayMs });
  const rocking = createCarRocking();
  let plan = null;
  let itemIndex = 0;
  let results = []; // { name, ms | null (DNF) }
  let run = null;
  let pacenoteRun = null; // the current stage's, when it has pacenotes
  let finished = false;
  let finishHeld = false;
  let busy = false; // picking / loading / spawning
  let prev = null; // car world position after the last step
  let simTime = 0;
  let flash = null; // { text, until, result? } short status after a split / GO / a rally's stage
  let resultRows = null; // stable array for the HUD while unchanged
  const step = { x: 0, z: 0 };
  let shownRed = 0; // countdown lights already beeped for
  let shownProgress = null; // plan panel + map icons are rebuilt when this key changes
  let nextProgressSave = 0;
  const online = new WeakMap(); // result -> { rank, vehicle, count, leader } | { error } | null while sending

  const hud = createRallyHud({
    retire: () => run?.retire(),
    restart: () => restartStage(),
    pick: () => choose(),
    newRally: () => choose(),
    pickAgain: () => choose(),
    mainMenu: () => openMainMenu?.(),
  });
  const planHud = createRallyPlanHud();
  const pacenoteHud = createPacenoteHud();

  const isLive = () => !!run?.isLive();
  addressSearch.setBlocked(isLive);
  routeGuidance.setBlocked(isLive);

  const currentItem = () => plan?.items[itemIndex] ?? null;
  const bestKey = (stage) => localBestKey(plan.source, stage.id);

  function saveProgress() {
    if (!keepsProgress) return;
    nextProgressSave = simTime + PROGRESS_SAVE_S;
    writeSaveField('status', plan ? progressStatus() : null);
    if (!plan) return writeSaveField('rallyProgress', null);
    writeSaveField('rallyProgress', { kind: plan.kind, source: plan.source, id: plan.id, itemIndex, results, run: finished ? null : run?.snapshot() ?? null });
  }

  /** Where the game stands, for the main menu's mode card. */
  function progressStatus() {
    const head = `${plan.name}\n${getVehicle(getVehicleId()).name}`;
    const stages = plan.items.filter((i) => i.type === 'stage').length;
    if (finished) {
      const dnf = results.some((r) => r.ms == null);
      return `${head}\nFinished · ${dnf ? 'DNF' : formatTime(results.reduce((sum, r) => sum + r.ms, 0))}`;
    }
    const ss = plan.items.slice(0, itemIndex + 1).filter((i) => i.type === 'stage').length;
    const item = currentItem();
    if (item.type !== 'stage') return `${head}\nLiaison to ${pointLabel(item.point.type).toLowerCase()} · ${ss}/${stages} stages done`;
    const { phase } = run.state;
    const where = phase === 'running' ? `${formatTime(run.elapsedMs())} on the clock` : phase === 'afterFinish' ? 'past the finish' : 'before the start';
    return `${head}\nSS${ss}/${stages} ${item.stage.name} · ${where}`;
  }

  function carPosition() {
    return carManager.getVehicle()?.chassisBody.position ?? null;
  }

  /**
   * Makes the current item the one timed and checked; scenery for the whole plan stays up.
   * @param {object | null} [savedRun] - the stage's run as saved, to carry on with.
   */
  function showItem(savedRun = null) {
    const item = currentItem();
    scenery.setActive(plan.items.slice(0, itemIndex).reduce((n, it) => n + itemPoints(it).length, 0));
    run = null;
    pacenoteRun = null;
    resultRows = null;
    if (item?.type === 'stage') {
      if (item.stage.pacenotes?.notes.length) pacenoteRun = createPacenoteRun(item.stage.pacenotes, viewFrame);
      const best = readLocalBests()[bestKey(item.stage)] ?? null;
      run = createStageRun({ points: item.stage.points, getGate: scenery.getGate, best, onEvent: (e) => onStageEvent(item.stage, best, e) });
      if (savedRun) run.restore(savedRun);
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
    if (event.type === 'countdown') saveProgress();
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
      const all = readLocalBests();
      if (!all[bestKey(stage)] || event.ms < all[bestKey(stage)].totalMs) {
        all[bestKey(stage)] = { totalMs: event.ms, splits: run.state.splits };
        writeLocalBests(all);
      }
      const result = { name: stage.name, ms: event.ms, splits: run.state.splits, penaltyMs: run.penaltyMs(), best };
      submitOnline(stage, result);
      if (plan.kind === 'rally') showStageDone(result);
      itemDone(result);
    }
    if (event.type === 'retired') itemDone({ name: stage.name, ms: null, splits: run.state.splits, penaltyMs: 0, best });
  }

  /** Official stages only; the results card shows the rank once it's back. */
  function submitOnline(stage, result) {
    if (!leaderboardEnabled() || plan.source !== OFFICIAL_SCENARIO_SOURCE || !plan.sha) return;
    online.set(result, null);
    const vehicle = getVehicleId();
    submitStageTime({
      stage: stage.id,
      sha: plan.sha,
      playerId,
      name: getPlayerName() ?? '',
      vehicle,
      totalMs: result.ms,
      splits: result.splits,
      penaltyMs: result.penaltyMs,
    })
      .then(({ board, rank }) => online.set(result, { rank, vehicle, count: board.entries.length, leader: board.entries[0] }))
      .catch((err) => {
        console.warn('Leaderboard:', err);
        online.set(result, { error: err.message });
      })
      .finally(() => {
        resultRows = null;
        if (flash?.result === result) showStageDone(result);
      });
  }

  /** Rally: the stage just driven, and its world rank once that's back, over the next item's status. */
  function showStageDone(result) {
    const rank = online.has(result) ? `  ·  World rank: ${onlineRank(online.get(result))}` : '';
    flash = { text: `${result.name}: ${formatTime(result.ms)}${rank}`, until: simTime + STAGE_DONE_SHOW_S, result };
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
    // The next item's run first: the saved status reads it.
    showItem();
    saveProgress();
  }

  /** Puts the car just before the item's first point, facing along the road towards it; teleports there first unless the world is already loaded around it. */
  async function spawnAt(index, teleport = true) {
    const points = itemPoints(plan.items[index]);
    const first = points[0];
    if (!first) return;
    if (teleport && !(await addressSearch.teleport(first.lat, first.lon, plan.name))) return;
    const at = viewFrame.fromLatLon(first.lat, first.lon);
    const next = points[1] ? viewFrame.fromLatLon(points[1].lat, points[1].lon) : null;
    const frame = controlFrame(streets, at.x, at.z, first, null, next, 40);
    let pos = at;
    let dirX = next ? next.x - at.x : 0;
    let dirZ = next ? next.z - at.z : 1;
    if (frame) {
      pos = frame.walk(-SPAWN_BACK_M);
      ({ dirX, dirZ } = pos);
    }
    const y = (terrain.surfaceHeightAt(pos.x, pos.z) ?? 0) + SPAWN_DROP_M;
    const quat = new CANNON.Quaternion();
    // Chassis forward is local +z.
    quat.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.atan2(dirX, dirZ));
    carManager.getReset()?.(new CANNON.Vec3(pos.x, y, pos.z), quat);
    parkCar();
    prev = null;
  }

  /**
   * @param {'teleport' | 'place' | null} spawn - how to bring the car to the item, if at all.
   * @param {object | null} [savedRun] - the current stage's run as saved.
   */
  async function startPlan(newPlan, index = 0, previousResults = [], spawn = 'teleport', savedRun = null) {
    plan = newPlan;
    scenery.setPoints(plan.items.flatMap(itemPoints));
    scenery.setBase(plan.base);
    itemIndex = index;
    results = previousResults;
    finished = itemIndex >= plan.items.length;
    if (finished) return;
    showItem(savedRun);
    saveProgress();
    if (spawn) await spawnAt(itemIndex, spawn === 'teleport');
    routeToItem();
  }

  async function choose() {
    if (busy) return;
    busy = true;
    try {
      const picked = await pickPlan(picker, { vehicleId: getVehicleId() });
      if (!picked) return; // Back: keep whatever was shown
      routeGuidance.stop();
      scenery.clear();
      plan = null;
      run = null;
      finished = false;
      saveProgress();
      if (picked.vehicleId !== getVehicleId() || getVehicleColor(picked.vehicleId) !== carManager.getColor()) switchVehicle(picked.vehicleId);
      else if (!sameTyreSetup(getTyreSetup(picked.vehicleId), carManager.getVehicle()?.tyreSetup)) carManager.setTyreSetup(getTyreSetup(picked.vehicleId));
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
        if (r && online.has(r)) rows.push(...onlineRows(online.get(r)));
      } else {
        for (const r of results) {
          rows.push([r.name, r.ms == null ? 'DNF' : formatTime(r.ms)]);
          if (online.has(r)) rows.push(...onlineRows(online.get(r)));
        }
        const dnf = results.some((r) => r.ms == null);
        rows.push(['Total', dnf ? 'DNF' : formatTime(results.reduce((sum, r) => sum + r.ms, 0))]);
      }
      resultRows = rows;
    }
    return {
      title: plan.kind === 'stage' ? `${plan.name} · finished` : `${plan.name} · rally finished`,
      results: resultRows,
      buttons: plan.kind === 'stage' ? ['restart', 'pick', 'mainMenu'] : ['newRally', 'mainMenu'],
    };
  }

  function onlineRank(entry) {
    if (!entry) return 'Sending…';
    if (entry.error) return entry.error;
    return entry.rank ? `${entry.rank} / ${entry.count} · ${getVehicle(entry.vehicle).name}` : '-';
  }

  function onlineRows(entry) {
    const rows = [['World rank', onlineRank(entry)]];
    if (!entry || entry.error) return rows;
    if (entry.leader) rows.push(['World best', `${formatTime(entry.leader.totalMs)} · ${entry.leader.name} · ${getVehicle(entry.leader.vehicle).name}`]);
    return rows;
  }

  /** Where an item stands: 'done', 'current' or ''. */
  const itemState = (i) => (finished || i < itemIndex ? 'done' : i === itemIndex ? 'current' : '');
  /** Where point j of the current stage stands. */
  const pointState = (i, j) => {
    const state = itemState(i);
    if (state !== 'current') return state;
    return j < run.state.next ? 'done' : j === run.state.next ? 'current' : '';
  };

  /** Side panel: the itinerary, stage by stage. */
  function planView() {
    const rows = [];
    let ss = 0;
    plan.items.forEach((item, i) => {
      const state = itemState(i);
      if (item.type !== 'stage') {
        rows.push({ label: pointLabel(item.point.type), state });
        return;
      }
      // Results hold one entry per stage driven, in itinerary order.
      const result = state === 'done' ? results[ss] : null;
      ss++;
      rows.push({ label: `SS${ss} ${item.stage.name}`, value: result ? (result.ms == null ? 'DNF' : formatTime(result.ms)) : '', state });
    });
    return { title: plan.name, rows };
  }

  /** Map icons: liaison points, the current stage's controls, other stages' start + finish; no PCs. */
  function mapPoints() {
    const points = [];
    const add = (p, label, state) =>
      points.push({ lat: p.lat, lon: p.lon, color: rallyFormat.pointTypes[p.type]?.color ?? 0x808080, label, gate: p.type !== 'base', done: state === 'done', selected: state === 'current' });
    if (plan.base) add({ ...plan.base, type: 'base' }, rallyFormat.pointTypes.base.short, '');
    let ss = 0;
    plan.items.forEach((item, i) => {
      if (item.type !== 'stage') {
        add(item.point, rallyFormat.pointTypes[item.point.type]?.short ?? '', itemState(i));
        return;
      }
      ss++;
      const current = itemState(i) === 'current';
      item.stage.points.forEach((p, j) => {
        if (p.type === 'passageControl' || (!current && p.type !== 'start' && p.type !== 'finish')) return;
        const label = p.type === 'start' && plan.kind === 'rally' ? `SS${ss}` : rallyFormat.pointTypes[p.type].short;
        add(p, label, pointState(i, j));
      });
    });
    return points;
  }

  function syncProgress() {
    const key = plan ? `${itemIndex}|${run?.state.next}|${finished}|${results.length}` : '';
    if (shownProgress && key === shownProgress.key && plan === shownProgress.plan) return;
    shownProgress = { key, plan };
    planHud.render(plan?.kind === 'rally' ? planView() : null);
    onMapPoints?.(plan ? mapPoints() : []);
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
      status: flash && simTime < flash.until ? flash.text : liaisonStatus(item.point.type, dist),
      next: dist == null ? '' : `${pointLabel(item.point.type)} · ${dist} m`,
    };
  }

  /** Notes from the countdown to the finish. */
  function pacenoteView() {
    const phase = run?.state.phase;
    const pos = carPosition();
    if (!pacenoteRun || !pos || busy || (phase !== 'countdown' && phase !== 'running')) return null;
    pacenoteRun.update(pos, phase === 'countdown');
    return { pacenotes: currentItem().stage.pacenotes, indices: pacenoteRun.shown() };
  }

  function liaisonStatus(type, dist) {
    const label = pointLabel(type).toLowerCase();
    if (rallyFormat.pointTypes[type]?.stop && dist != null && dist < NEAR_ZONE_M) return `Stop in the ${label} zone`;
    return `Liaison: drive to ${label}`;
  }

  // Between throttled saves, so a reload or a closed tab keeps the clock where it stood.
  window.addEventListener('pagehide', () => {
    if (plan && !busy) saveProgress();
  });

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
        const json = await opened.readJson(filePath(rallyFormat.folder, def, progress.id));
        if (!json) throw new Error(`${progress.id} is gone from ${progress.source}`);
        const saved = await buildPlan(progress.kind, progress.source, opened, progress.id, json);
        // The car resumes where it was saved (lib/carState.js), so it needs no spawn.
        await startPlan(saved, progress.itemIndex ?? 0, progress.results ?? [], null, progress.run ?? null);
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
      if (keepsProgress && simTime >= nextProgressSave) saveProgress();
      const item = currentItem();
      if (item.type === 'stage') {
        run.step(dt, prev, step, carManager.getVehicle().chassisBody.velocity.length());
      } else {
        const gate = scenery.getGate(0);
        const dist = gate ? Math.hypot(step.x - gate.x, step.z - gate.z) : Infinity;
        const pointType = rallyFormat.pointTypes[item.point.type];
        const done = pointType?.stop
          ? dist < LIAISON_STOP_ZONE_M && carManager.getVehicle().chassisBody.velocity.length() < LIAISON_STOP_SPEED
          : dist < gate?.halfWidth + LIAISON_PASS_PAD_M;
        if (done) {
          flash = { text: `${pointLabel(item.point.type)} ✓`, until: simTime + SPLIT_SHOW_S };
          if (pointType?.tyres) (onTyreService ?? (() => carManager.getVehicle()?.repairTyres?.()))();
          if (pointType?.repairs) carManager.getVehicle()?.heat?.repair();
          itemDone(null);
        }
      }
      prev.x = step.x;
      prev.z = step.z;
    },

    /** Per frame: scenery, start lights, HUD. */
    update(dt) {
      scenery.update(dt, carPosition());
      // A liaison item is its one point: index 0.
      const next = run ? (run.state.phase !== 'done' && run.state.phase !== 'retired' ? run.state.next : -1) : plan && !finished && currentItem() ? 0 : -1;
      scenery.setNext(next);
      if (run && run.startIndex >= 0) {
        const { red, green } = run.lights();
        scenery.setLights(run.startIndex, red, green);
        // A beep as each countdown light comes on.
        if (red > shownRed) onStartBeep?.(false);
        shownRed = red;
      }
      // Results up: parked under the drone, as with a menu open, until a new run starts.
      const hold = finished && !!plan;
      if (hold !== finishHeld) {
        finishHeld = hold;
        onFinishHold?.(hold);
      }
      hud.render(view());
      pacenoteHud.render(pacenoteView());
      syncProgress();
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
