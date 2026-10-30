// Rally game mode: picks a stage or rally from a scenario source, then runs its items in
// order. A stage item is a stageRun.js; a point item (service park, regroup, ...) is a
// liaison checkpoint to drive through, routed by the Navigation tab. Teleport and
// navigation are blocked while a stage is live; R rocks the car instead of resetting it.
// A rally's liaison leg longer than SKIP_LIAISON_M can be skipped: fade to black, the car moved
// before the next point, fade back in.
// The rally clock and weather (rallyConditions.js) run at real speed from the rally's start time,
// time jumps add to them and each parc fermé ends the day; a single stage runs from its picked time and weather.
// Once stopped the crew can do field fixes (spare wheel, patches, the carried cans; fieldRepair.js),
// at a penalty on a live stage, and the car can be inspected. Service points open a repair menu against a time budget per visit
// (lib/serviceRepairs.js); going over it adds a late penalty to the rally total.
// Progress (item, results, the live stage's clock and controls) lives in the game's save slot,
// so a game left mid-stage resumes there with the car where it stood (lib/carState.js).

import * as CANNON from 'cannon-es';
import { OFFICIAL_SCENARIO_SOURCE } from '../../config.js';
import { getAirTempC, getWetness, getRainMmH } from '../../lib/weather.js';
import { formatDistance, formatVolume, formatTemp, formatRain, formatSpeed, longDistanceValue, longDistanceUnit } from '../../lib/units.js';
import { skyLabel } from '../../lib/rally/rallyWeather.js';
import { leaderboardEnabled, submitStageTime, fetchStageBoard, playerHash, rallyTotals, bestPerPlayer } from '../../lib/leaderboard.js';
import { leaderboardAllowed } from '../../lib/privacy.js';
import { readSaveField, writeSaveField, getActiveStartId } from '../../lib/saves.js';
import { parseSource, openSource } from '../../lib/scenarios/source.js';
import { rallyFormat, resolvePointRefs, parseClockTime, DEFAULT_START_TIME } from '../../lib/scenarios/rally.js';
import { filePath } from '../../lib/scenarios/paths.js';
import { reverseKey, splitReverseKey, drivenStagePoints, inVersion } from '../../lib/rally/stageReverse.js';
import { savedRouteFor } from '../../lib/rally/savedRoute.js';
import { bearingDeg } from '../../lib/routing.js';
import { controlFrame } from '../../lib/scenarios/roadSnap.js';
import { createControlScenery } from '../../lib/rally/controlScenery.js';
import { readLocalBests, writeLocalBests, localBestKey, localRallyKey, addLocalRun } from '../../lib/rally/localBest.js';
import { createRallyHud, formatTime, formatDelta } from '../../hud/rallyHud.js';
import { createRallyPlanHud } from '../../hud/rallyPlanHud.js';
import { createStageRun } from './stageRun.js';
import { createPacenoteRun } from './pacenoteRun.js';
import { createPacenoteHud } from '../../hud/pacenoteHud.js';
import { createCarRocking } from '../carRocking.js';
import { createZonePicking } from './zonePicking.js';
import { createFieldRepair } from './fieldRepair.js';
import { createRallyConditions, previewForecast, DEFAULT_STAGE_CONDITIONS } from './rallyConditions.js';
import { getVehicle, vehicleLabel } from '../../lib/vehicles/index.js';
import { getVehicleColor } from '../../lib/vehicleColors.js';
import { getTyreSetup, getSpareTyres } from '../../lib/garage.js';
import { fullSupplies } from '../../lib/supplies.js';
import { sameTyreSetup } from '../../lib/tyres/setup.js';
import { SERVICE_ZONES, latePenaltyMs, carParts } from '../../lib/serviceRepairs.js';

const SPAWN_BACK_M = 120; // spawn this far before a stage's first point, along the road
const SPAWN_DROP_M = 1.5;
const LIAISON_PASS_PAD_M = 3; // liaison point passed within its half width + this
const LIAISON_STOP_ZONE_M = 15; // stop-type liaison points: stop within this
const LIAISON_STOP_SPEED = 0.6; // m/s: counts as stopped
const REFUEL_MENU_SPEED = 1.5; // m/s: a passed refuel point's menu opens once the car is this slow
const REFUEL_WAIT_M = 60; // ...unless it drives on further than this first
const ROUTE_MIN_M = 250; // closer targets aren't worth a navigation route
const LEAVE_STAGE_NEAR_M = 1000; // the liaison leaves heading on past the last stage's end while the car is this near it
const JUMP_GUARD_M = 50; // a step moving the car further (teleport, reset) checks nothing
const SPLIT_SHOW_S = 5;
const WORLD_TOP_N = 10; // world times on the finished plan's results card
const STAGE_DONE_SHOW_S = 10; // rally: a finished stage's time + world rank over the next item
const GO_SHOW_S = 1.5;
const NEAR_ZONE_M = 80;
// Turn-around hint: straight-line distance to the next point growing this long.
const WRONG_WAY_S = 5;
const WRONG_WAY_RATE = 0.5; // m/s: slower changes (stopped, sliding about) neither count nor clear it
const WRONG_WAY_TEXT = 'Wrong way – turn around';
const PROGRESS_SAVE_S = 1; // throttle for the live stage's clock, alongside the car state
// m/s: Inspect car shows once this slow, kept until faster than the second.
const INSPECT_SHOW_SPEED = 0.8;
const INSPECT_HIDE_SPEED = 1.5;
const SKIP_LIAISON_M = 3000; // straight line to the next point
const SKIP_ROAD_FACTOR = 1.3; // road distance per straight-line metre, for a skip's fuel
const SKIP_MIN_PART_LEVEL = 0.3; // any mechanical part (tyre tread, shock, gearbox, fluids...) below this blocks a skip
const SKIP_SPEED_KMH = 50; // a skipped liaison's average speed, for the clock
const TYRE_FITTING_MIN = 10; // clock minutes at a tyre fitting zone
const REFUEL_MIN = 5; // ...and at a refuel zone
const NIGHT_CAPTION_MS = 1500; // end of a rally day: the black screen holds this long
const RAIN_SHOWN_MM_H = 0.1; // forecast rain below this reads as none
const DAMAGE_SHOWN_LEVEL = 0.95; // a 'warn' part at or above this health is only hot / cold, not damaged

const formatClock = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
const minutesText = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const DEFAULT_START_MIN = parseClockTime(DEFAULT_START_TIME);


const stageKind = rallyFormat.kinds.find((k) => k.id === 'stage');
const rallyKind = rallyFormat.kinds.find((k) => k.id === 'rally');
const pointLabel = (type) => rallyFormat.pointTypes[type]?.label ?? type;
// Itinerary icons for point types without a flag to key them on.
const NAMED_ICONS = { podium: 'podium', serviceParkIn: 'parkIn', serviceParkOut: 'parkOut' };

/**
 * A stage file's version (lib/rally/stageReverse.js) -> { id (its file key, + the reverse suffix), name, points,
 * pacenotes, surfaces, objects, route (lib/rally/savedRoute.js, null when missing or stale) }. `doc`: stageKind.fromFile
 * result; both versions share its objects and surfaces.
 */
function readStage(doc, key, reverse = false) {
  const { name, items, pacenotes, reversePacenotes, surfaces, objects, route, reverseRoute } = doc;
  const points = drivenStagePoints(items, { reverse, defaultWidth: rallyFormat.defaultGateWidth });
  return {
    id: reverse ? reverseKey(key) : key,
    name: reverse ? `${name} (reverse)` : name,
    points,
    route: savedRouteFor(reverse ? reverseRoute : route, points),
    pacenotes: reverse ? reversePacenotes : pacenotes,
    surfaces,
    objects: objects.filter((object) => inVersion(object, reverse)),
  };
}

/** Plan items for a picked file: stage -> one stage item (a stageReverse.js reverse key: its reverse version); rally -> its itinerary. */
async function buildPlan(kind, source, opened, key, json) {
  if (kind === 'stage') {
    const { key: fileKey, reverse } = splitReverseKey(key);
    const doc = stageKind.fromFile(json);
    const stage = readStage(doc, fileKey, reverse);
    return { kind, source, sha: opened.sha, id: key, name: stage.name, meta: doc.meta, items: [{ type: 'stage', stage }], objects: [] };
  }
  const rally = rallyKind.fromFile(json);
  const docs = new Map(); // stage key -> its file read
  const stages = new Map(); // stage id -> its version
  const items = [];
  for (const item of resolvePointRefs(rally.items)) {
    if (item.type === 'base') continue;
    if (item.type !== 'ref') {
      items.push({ type: 'point', point: item });
      continue;
    }
    if (!docs.has(item.ref)) {
      const stageJson = await opened.readJson(filePath(rallyFormat.folder, stageKind, item.ref));
      if (!stageJson) throw new Error(`Stage ${item.ref} is missing from ${source}`);
      docs.set(item.ref, stageKind.fromFile(stageJson));
    }
    const id = item.reverse ? reverseKey(item.ref) : item.ref;
    if (!stages.has(id)) stages.set(id, readStage(docs.get(item.ref), item.ref, !!item.reverse));
    const stage = stages.get(id);
    items.push({ type: 'stage', stage: { ...stage, name: item.name || stage.name } });
  }
  const base = rally.items.find((item) => item.type === 'base') ?? null;
  return { kind, source, sha: opened.sha, id: key, name: rally.name, meta: rally.meta, startTime: rally.startTime, base, items, objects: rally.objects };
}

/** The plan's course objects: the rally's own and each stage's once, however often (and whichever way) it's driven. */
const planObjects = (plan) => [...new Set(plan.items.flatMap((item) => item.stage?.objects ?? []))].concat(plan.objects ?? []);

/** The plan's surface sections: each stage's once (they stay in force on liaisons too). */
const planSurfaces = (plan) => [...new Set(plan.items.map((item) => item.stage?.surfaces ?? []))].flat();

/** Rally days: one plus a parc fermé (`endsDay` point) each. */
const planDays = (plan) => 1 + plan.items.filter((item) => item.type === 'point' && rallyFormat.pointTypes[item.point.type]?.endsDay).length;

/** ui/rallyInfoDialog.js forecast rows from rallyConditions.js forecast rows; `withDay`: a rally's day number in the label. */
function formatForecast(rows, displayMs, withDay) {
  return rows.map((s) => {
    const date = new Date(displayMs(s.ms));
    return {
      state: s.state,
      label: `${withDay ? `Day ${s.day} ` : ''}${date.toLocaleDateString(undefined, { weekday: 'short' })} ${formatClock(date)}`,
      sky: skyLabel(s),
      temp: formatTemp(s.tempC),
      rain: s.precipMmH >= RAIN_SHOWN_MM_H ? formatRain(s.precipMmH) : '',
      wind: formatSpeed(s.windMs * 3.6),
    };
  });
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
    lastFile: readSaveField('lastFile'),
    onFilePick: (file) => writeSaveField('lastFile', file),
    forecast: (plan, stageConditions) => planForecast(plan, stageConditions),
  });
}

/**
 * The forecast a picked plan would start in: a rally's days from its start time, a single stage's day in Live
 * weather (null in fixed weather). Rows as ui/rallyInfoDialog.js shows them; empty offline.
 */
async function planForecast(plan, stageConditions) {
  const at = plan.base ?? planStart(plan);
  if (!at) return null;
  if (plan.kind === 'stage') {
    const { timeOfDay, weather } = { ...DEFAULT_STAGE_CONDITIONS, ...stageConditions };
    if (weather !== 'live') return null;
    const { rows, displayMs } = await previewForecast({ lat: at.lat, lon: at.lon, timeOfDay });
    return formatForecast(rows, displayMs, false);
  }
  const days = planDays(plan);
  const { rows, displayMs } = await previewForecast({ lat: at.lat, lon: at.lon, days, startMin: parseClockTime(plan.startTime) ?? DEFAULT_START_MIN });
  return formatForecast(rows, displayMs, true);
}

/** Where a plan starts: its first item's first point (lat/lon), or null. */
export const planStart = (plan) => itemPoints(plan?.items[0])[0] ?? null;

/**
 * @param {object} deps
 * @param {{plan: object, vehicleId: string} | null} deps.initialPick - picked before the world loaded around it.
 * @param {() => string} deps.getVehicleId
 * @param {(vehicleId: string) => void} deps.switchVehicle
 * @param {() => void} deps.parkCar - pulls the handbrake once the car is placed at a stage.
 * @param {(opts?: {fitted?: boolean}) => void} [deps.onTyreService] - a tyre service point was passed (default: fresh tyres), or its props clicked ({ fitted: false }).
 * @param {() => void} [deps.onRefuel] - a refuel point was passed or its bowser clicked.
 * @param {(zone: object, usedMin: number) => Promise<number>} [deps.onService] - a service visit's menu (SERVICE_ZONES entry, minutes already spent): resolves with the minutes the repairs took.
 * @param {(opts: { fieldFix: (action: object, part: object) => void, penaltyApplies: () => boolean }) => void} [deps.onInspect] - Inspect car (stopped), with its field fixes.
 * @param {(info: object) => void} [deps.onRallyInfo] - the base tents were clicked: ui/rallyInfoDialog.js open() data.
 * @param {HTMLCanvasElement} [deps.canvas] - with `camera`: service props answer the mouse (zonePicking.js).
 * @param {import('three').Camera} [deps.camera]
 * @param {boolean} deps.keepsProgress - false: nothing but the car pick survives a reload.
 * @param {string} deps.playerId - for the online leaderboard.
 * @param {() => string | null} deps.getPlayerName
 * @param {() => void} [deps.onSparkle] - sound when a control throws sparkles.
 * @param {() => void} [deps.onRepair] - sound of a field fix.
 * @param {(speed: number, spec: object) => void} [deps.onPropHit] - sound when the car knocks a flag / board / light over.
 * @param {(long: boolean) => void} [deps.onStartBeep] - timing beep: short (countdown light, check-in), long (GO, finish).
 * @param {() => number} [deps.getTimeOfDayMs] - simulated clock (epoch ms) for the control clocks.
 * @param {(clock: (() => number) | null) => void} deps.setClock - daylight.js: the rally clock drives the sun.
 * @param {(on: boolean) => void} deps.setLiveWeather - the free-roam forecast feed, off while a plan sets the weather.
 * @param {(points: object[]) => void} [deps.onMapPoints] - plan icons for the minimap / Navigation map (scenarioPointIcon.js).
 * @param {() => void} [deps.onStartLine] - stopped at a stage's start line (countdown begins).
 * @param {() => void} [deps.onFinishLine] - a stage's finish line passed.
 * @param {(held: boolean) => void} [deps.onFinishHold] - true while the finished plan's results are up (car parked, drone view).
 * @param {() => void} [deps.openMainMenu]
 * @param {ReturnType<import('../../ui/screenFade.js').createScreenFade>} [deps.screenFade] - liaison skips need it.
 * @param {() => void} [deps.snapCamera] - the camera jumps to the car (after a skip).
 */
export function createRallySession({ scene, world, streets, terrain, viewFrame, carManager, addressSearch, routeGuidance, picker, initialPick, getVehicleId, switchVehicle, parkCar, onTyreService, onRefuel, onService, onInspect, onRallyInfo, canvas, camera, keepsProgress, playerId, getPlayerName, onSparkle, onRepair, onPropHit, onStartBeep, onStartLine, onFinishLine, getTimeOfDayMs, setClock, setLiveWeather, onMapPoints, onFinishHold, onStageLive, openMainMenu, screenFade, snapCamera }) {
  const conditions = createRallyConditions({ setClock, setLiveWeather });
  const clockMs = () => conditions.displayMs(getTimeOfDayMs?.() ?? Date.now());
  const scenery = createControlScenery({ scene, world, streets, terrain, viewFrame, onSparkle, onHit: onPropHit, getTimeOfDayMs: clockMs });
  const rocking = createCarRocking();
  let plan = null;
  let itemIndex = 0;
  let results = []; // { name, ms | null (DNF) }
  let services = {}; // item index -> { usedMin, penaltyMs }: service visits so far
  let itemMark = null; // the clock and weather when the current item began: a restarted stage goes back to it
  let serviceOpen = false;
  let stopped = false; // slow enough to inspect the car
  let run = null;
  let pacenoteRun = null; // the current stage's, when it has pacenotes
  let finished = false;
  let finishHeld = false;
  let stageLive = false; // stage clock running
  let busy = false; // picking / loading / spawning
  let prev = null; // car world position after the last step
  let refuelWaitM = null; // metres driven since passing a refuel point whose menu waits for a stop
  let simTime = 0;
  let flash = null; // { text, until, result? } short status after a split / GO / a rally's stage
  let away = null; // { key, dist, time, s }: how long the distance to the current target has been growing
  let resultRows = null; // stable array for the HUD while unchanged
  const step = { x: 0, z: 0 };
  let shownRed = 0; // countdown lights already beeped for
  let shownProgress = null; // plan panel + map icons are rebuilt when this key changes
  let nextProgressSave = 0;
  const online = new WeakMap(); // result -> { rank, vehicle, count, leader } | { error } | null while sending
  const sending = new WeakMap(); // result -> its submit, settled once the board has it (or it failed)
  let worldTop = null; // finished plan's world times: { rows, myHash } | { error } | { loading: true }; null when off
  let worldSeq = 0;

  const hud = createRallyHud({
    retire: () => run?.retire(),
    inspect: () => onInspect?.(fieldFix && plan && !finished ? { fieldFix: fieldFix.apply, penaltyApplies: fieldFix.penaltyApplies } : {}),
    restart: () => restartStage(),
    skipLiaison: () => skipLiaison(),
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
  const picking = canvas
    ? createZonePicking({
        canvas,
        camera,
        scenery,
        getVehicle: () => carManager.getVehicle(),
        isEnabled: () => !!plan && !busy && !isLive(),
        onAction: (action, picked) => {
          if (action === 'tyres') onTyreService?.({ fitted: false });
          else if (action === 'refuel') onRefuel?.();
          else if (action === 'info') onRallyInfo?.(rallyInfo());
          else serviceAtProps(picked.index);
        },
      })
    : null;
  const fieldFix = canvas
    ? createFieldRepair({
        canvas,
        camera,
        getVehicle: () => carManager.getVehicle(),
        isEnabled: () => !!plan && !busy && !finished,
        getRun: () => run,
        onRepair,
        onDone(text, penaltyMs, clockMin) {
          conditions.advance(clockMin * 60_000);
          flash = { text: `${text} ✓${penaltyMs ? `  +${formatTime(penaltyMs)}` : ''}`, until: simTime + SPLIT_SHOW_S };
          saveProgress();
        },
      })
    : null;

  const currentItem = () => plan?.items[itemIndex] ?? null;
  const bestKey = (stage) => localBestKey(plan.source, stage.id);

  function saveProgress() {
    if (!keepsProgress) return;
    nextProgressSave = simTime + PROGRESS_SAVE_S;
    writeSaveField('status', plan ? progressStatus() : null);
    writeSaveField('done', !!plan && finished);
    if (!plan) return writeSaveField('rallyProgress', null);
    writeSaveField('rallyProgress', {
      kind: plan.kind,
      source: plan.source,
      id: plan.id,
      itemIndex,
      results,
      services,
      run: finished ? null : run?.snapshot() ?? null,
      conditions: conditions.snapshot(),
      mark: itemMark,
    });
  }

  /** Where the game stands, for the main menu's mode card. */
  function progressStatus() {
    const head = `${plan.name}\n${getVehicle(getVehicleId()).name}`;
    const stages = plan.items.filter((i) => i.type === 'stage').length;
    if (finished) {
      const dnf = results.some((r) => r.ms == null);
      return `${head}\nFinished · ${dnf ? 'DNF' : formatTime(rallyTotalMs())}`;
    }
    const ss = plan.items.slice(0, itemIndex + 1).filter((i) => i.type === 'stage').length;
    const item = currentItem();
    if (item.type !== 'stage') return `${head}\nLiaison to ${pointLabel(item.point.type).toLowerCase()} · ${ss}/${stages} stages done`;
    const { phase } = run.state;
    const where = phase === 'running' ? `${formatTime(run.elapsedMs())} on the clock` : phase === 'afterFinish' ? 'past the finish' : 'before the start';
    return `${head}\nSS${ss}/${stages} ${item.stage.name} · ${where}`;
  }

  const servicePenaltyMs = () => Object.values(services).reduce((sum, v) => sum + (v.penaltyMs ?? 0), 0);
  /** Stage times plus late-from-service penalties. */
  const rallyTotalMs = () => results.reduce((sum, r) => sum + r.ms, 0) + servicePenaltyMs();
  const serviceZone = (item) => (item?.type === 'point' ? SERVICE_ZONES[rallyFormat.pointTypes[item.point.type]?.service] ?? null : null);

  /** Service visit at itinerary item i: the repair menu against what's left of its budget. */
  async function openService(i) {
    const zone = serviceZone(plan.items[i]);
    if (!zone || !onService || serviceOpen) return;
    serviceOpen = true;
    const forPlan = plan;
    try {
      const before = services[i] ?? { usedMin: 0, penaltyMs: 0 };
      const minutes = await onService(zone, before.usedMin);
      if (!minutes || plan !== forPlan) return;
      const usedMin = before.usedMin + minutes;
      const penaltyMs = latePenaltyMs(usedMin, zone.budgetMin);
      services = { ...services, [i]: { usedMin, penaltyMs } };
      conditions.advance(minutes * 60_000);
      const extra = penaltyMs - before.penaltyMs;
      flash = { text: `${zone.label}: ${minutes} min${extra ? `  late +${formatTime(extra)}` : ''}`, until: simTime + SPLIT_SHOW_S };
      resultRows = null;
      saveProgress();
    } finally {
      serviceOpen = false;
    }
  }

  /**
   * Service props clicked (point `flatIndex` of the plan): the latest visit to that spot, checking
   * in first when it is the current item. A spot not reached yet has no visit.
   */
  function serviceAtProps(flatIndex) {
    let n = 0;
    const at = plan?.items.findIndex((item) => (n += itemPoints(item).length) > flatIndex) ?? -1;
    const point = at >= 0 ? plan.items[at].point : null;
    if (!point) return;
    const same = (item) => item.type === 'point' && item.point.type === point.type && item.point.lat === point.lat && item.point.lon === point.lon;
    for (let i = Math.min(itemIndex, plan.items.length) - 1; i >= 0; i--) {
      if (same(plan.items[i])) return openService(i);
    }
    if (!finished && same(currentItem())) return checkIn(currentItem());
    flash = { text: `${pointLabel(point.type)} opens when you reach it`, until: simTime + SPLIT_SHOW_S };
  }

  /** A liaison point reached: its service, if any, then on to the next item. */
  function checkIn(item) {
    const pointType = rallyFormat.pointTypes[item.point.type];
    flash = { text: `${pointLabel(item.point.type)} ✓`, until: simTime + SPLIT_SHOW_S };
    if (pointType?.tyres) {
      (onTyreService ?? (() => carManager.getVehicle()?.repairTyres?.()))();
      conditions.advance(TYRE_FITTING_MIN * 60_000);
    }
    if (pointType?.refuel) {
      refuelWaitM = 0;
      conditions.advance(REFUEL_MIN * 60_000);
    }
    const i = itemIndex;
    itemDone(null);
    if (pointType?.service) openService(i);
    // The rally's last parc fermé just ends it.
    if (pointType?.endsDay && !finished) endOfDay(item.point);
  }

  /** Parc fermé: fade to black over the night, the clock moved to the next day's start. */
  async function endOfDay(point) {
    const startMin = parseClockTime(point.nextStart) ?? parseClockTime(plan.startTime) ?? DEFAULT_START_MIN;
    const day = conditions.getDay();
    if (!screenFade) {
      conditions.endDay(startMin);
      carManager.getVehicle()?.coolToAir?.();
      itemMark = conditions.snapshot();
      flash = { text: `Day ${conditions.getDay()} · ${minutesText(startMin)}`, until: simTime + SPLIT_SHOW_S };
      return saveProgress();
    }
    busy = true;
    try {
      parkCar();
      await screenFade.out(`End of day ${day}\nDay ${day + 1} starts at ${minutesText(startMin)}`);
      conditions.endDay(startMin);
      carManager.getVehicle()?.coolToAir?.();
      // The next item begins in the new day.
      itemMark = conditions.snapshot();
      saveProgress();
      await new Promise((resolve) => setTimeout(resolve, NIGHT_CAPTION_MS));
    } finally {
      busy = false;
      screenFade.in();
    }
    flash = { text: `Day ${conditions.getDay()} · ${minutesText(startMin)}`, until: simTime + SPLIT_SHOW_S };
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
    itemMark = conditions.snapshot();
    scenery.setActive(plan.items.slice(0, itemIndex).reduce((n, it) => n + itemPoints(it).length, 0));
    hideOtherRuns();
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

  /** A stage driven more than once (either way) keeps the scenery of one run: the current or next one, else the last. */
  function hideOtherRuns() {
    const shownRun = new Map(); // stage file key -> item index
    const road = (item) => splitReverseKey(item.stage.id).key;
    plan.items.forEach((item, i) => {
      if (item.type === 'stage' && (!shownRun.has(road(item)) || shownRun.get(road(item)) < itemIndex)) shownRun.set(road(item), i);
    });
    const hidden = [];
    let offset = 0;
    plan.items.forEach((item, i) => {
      const count = itemPoints(item).length;
      if (item.type === 'stage' && shownRun.get(road(item)) !== i) for (let k = 0; k < count; k++) hidden.push(offset + k);
      offset += count;
    });
    scenery.setHidden(hidden);
  }

  function routeToItem() {
    const target = itemPoints(currentItem())[0];
    const pos = carPosition();
    if (!target || !pos || plan.kind === 'stage') return;
    const { x, z } = viewFrame.fromLatLon(target.lat, target.lon);
    if (Math.hypot(x - pos.x, z - pos.z) <= ROUTE_MIN_M) return;
    routeGuidance.start({ lat: target.lat, lon: target.lon, label: pointLabel(target.type) }, { avoid: avoidLastStage(pos) });
  }

  /** Keeps the liaison off the last stage's road: fewest metres along it, and not turning back into it near its end. */
  function avoidLastStage(pos) {
    const stage = plan.items.slice(0, itemIndex).findLast((item) => item.type === 'stage')?.stage;
    if (!stage) return null;
    const line = stage.route ? stage.route.points.map(([lat, lon]) => ({ lat, lon })) : stage.points;
    const [a, b] = stage.points.slice(-2);
    const end = viewFrame.fromLatLon(b.lat, b.lon);
    const near = Math.hypot(end.x - pos.x, end.z - pos.z) < LEAVE_STAGE_NEAR_M;
    return { line, bearing: near ? bearingDeg(a, b) : null };
  }

  function onStageEvent(stage, best, event) {
    if (event.type === 'countdown') {
      saveProgress();
      onStartLine?.();
    }
    // Timing clock beeps: check-in at a time / stop control, and the clock stopping at the finish.
    if (event.type === 'checkIn') onStartBeep?.(false);
    if (event.type === 'finish') {
      onStartBeep?.(true);
      onFinishLine?.();
    }
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
      addLocalRun(bestKey(stage), { totalMs: event.ms, vehicle: getVehicleId() });
      const result = { name: stage.name, ms: event.ms, splits: run.state.splits, penaltyMs: run.penaltyMs(), best };
      submitOnline(stage, result);
      if (plan.kind === 'rally') showStageDone(result);
      itemDone(result);
    }
    if (event.type === 'retired') itemDone({ name: stage.name, ms: null, splits: run.state.splits, penaltyMs: 0, best });
  }

  /** Official stages only, unless the player opted out in Settings; the results card shows the rank once it's back. */
  function submitOnline(stage, result) {
    if (!leaderboardEnabled() || plan.source !== OFFICIAL_SCENARIO_SOURCE || !plan.sha) return;
    if (!leaderboardAllowed()) return;
    online.set(result, null);
    const vehicle = getVehicleId();
    const submit = submitStageTime({
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
    sending.set(result, submit);
  }

  /** The finished plan's world times (a rally: stage times summed per car), once this game's own submits are in. */
  function loadWorldTop() {
    const seq = ++worldSeq;
    worldTop = null;
    if (!leaderboardEnabled() || plan.source !== OFFICIAL_SCENARIO_SOURCE) return;
    worldTop = { loading: true };
    const ids = plan.items.filter((i) => i.type === 'stage').map((i) => i.stage.id);
    const kind = plan.kind;
    Promise.all(results.map((r) => sending.get(r)))
      .then(() => Promise.all([Promise.all(ids.map(fetchStageBoard)), playerHash(playerId)]))
      .then(
        ([boards, myHash]) => ({ rows: bestPerPlayer(kind === 'stage' ? boards[0].entries : rallyTotals(boards)), myHash }),
        (err) => ({ error: err.message })
      )
      .then((top) => {
        if (seq !== worldSeq) return;
        worldTop = top;
        resultRows = null;
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
      if (plan.kind === 'rally' && !results.some((r) => r.ms == null)) addLocalRun(localRallyKey(plan.source, plan.id), { totalMs: rallyTotalMs(), vehicle: getVehicleId() });
      resultRows = null;
      loadWorldTop();
      saveProgress();
      return;
    }
    // The next item's run first: the saved status reads it.
    showItem();
    saveProgress();
  }

  /**
   * Puts the car just before the item's first point, facing along the road towards it (the rally's
   * first item, unless `fromBase` is off: on the road beside the base, facing towards that point);
   * teleports there first unless the world is already loaded around it (`quiet`: no teleport effects).
   * @returns {Promise<boolean>} false when the car wasn't moved.
   */
  async function spawnAt(index, { teleport = true, quiet = false, fromBase = true } = {}) {
    const points = itemPoints(plan.items[index]);
    const atBase = fromBase && index === 0 && plan.base;
    const first = atBase ? plan.base : points[0];
    if (!first) return false;
    if (teleport && !(await addressSearch.teleport(first.lat, first.lon, plan.name, { quiet }))) return false;
    const at = viewFrame.fromLatLon(first.lat, first.lon);
    const nextPoint = atBase ? points[0] : points[1];
    const next = nextPoint ? viewFrame.fromLatLon(nextPoint.lat, nextPoint.lon) : null;
    // A lone liaison point faces as if arriving from the previous item.
    const prevPoint = next ? null : (index > 0 ? itemPoints(plan.items[index - 1]).at(-1) : plan.base) ?? null;
    const from = prevPoint ? viewFrame.fromLatLon(prevPoint.lat, prevPoint.lon) : null;
    const frame = controlFrame(streets, at.x, at.z, first, from, next, 40);
    let pos = at;
    let dirX = next ? next.x - at.x : 0;
    let dirZ = next ? next.z - at.z : 1;
    if (frame) {
      pos = atBase ? frame : frame.walk(-SPAWN_BACK_M);
      ({ dirX, dirZ } = pos);
    }
    const y = (terrain.surfaceHeightAt(pos.x, pos.z) ?? 0) + SPAWN_DROP_M;
    const quat = new CANNON.Quaternion();
    // Chassis forward is local +z.
    quat.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.atan2(dirX, dirZ));
    carManager.getReset()?.(new CANNON.Vec3(pos.x, y, pos.z), quat);
    parkCar();
    prev = null;
    return true;
  }

  /**
   * @param {'teleport' | 'place' | null} spawn - how to bring the car to the item, if at all.
   * @param {object | null} [savedRun] - the current stage's run as saved.
   * @param {object | null} [savedConditions] - the clock and weather to carry on with (rallyConditions.js snapshot()), else they start anew.
   */
  async function startPlan(newPlan, index = 0, previousResults = [], spawn = 'teleport', savedRun = null, savedServices = {}, savedConditions = null) {
    plan = newPlan;
    await startConditions(savedConditions);
    services = Object.fromEntries(Object.entries(savedServices ?? {}).filter(([i]) => Number(i) < index));
    scenery.setPoints(plan.items.flatMap(itemPoints));
    scenery.setBase(plan.base);
    scenery.setObjects(planObjects(plan));
    streets.setSurfaceSections(planSurfaces(plan));
    itemIndex = index;
    results = previousResults;
    finished = itemIndex >= plan.items.length;
    hideOtherRuns();
    worldSeq++;
    worldTop = null;
    if (finished) return loadWorldTop();
    showItem(savedRun);
    saveProgress();
    if (spawn) await spawnAt(itemIndex, { teleport: spawn === 'teleport' });
    routeToItem();
  }

  /** The plan's clock and weather: as saved, else a rally from its start time, a single stage from its picked conditions. */
  async function startConditions(saved) {
    if (saved && conditions.restore(saved)) return;
    const at = plan.base ?? planStart(plan);
    if (!at) return;
    if (plan.kind === 'stage') return conditions.startStage({ lat: at.lat, lon: at.lon, ...DEFAULT_STAGE_CONDITIONS, ...plan.conditions });
    await conditions.startRally({ lat: at.lat, lon: at.lon, startMin: parseClockTime(plan.startTime) ?? DEFAULT_START_MIN, days: rallyDays() });
  }

  const rallyDays = () => planDays(plan);

  /** A new event (picked, or a single stage restarted) starts in a brand new car, the picked spares and full cans on board. */
  function newCar() {
    const vehicle = carManager.getVehicle();
    vehicle?.makeNew?.();
    vehicle?.setSpareTyres?.(getSpareTyres(getVehicleId()));
    vehicle?.setSupplies?.(fullSupplies());
  }

  async function choose() {
    if (busy) return;
    busy = true;
    try {
      const picked = await pickPlan(picker, { vehicleId: getVehicleId() });
      if (!picked) return; // Back: keep whatever was shown
      routeGuidance.stop();
      scenery.clear();
      streets.setSurfaceSections([]);
      plan = null;
      run = null;
      finished = false;
      saveProgress();
      picked.plan.conditions = picked.conditions;
      if (picked.vehicleId !== getVehicleId() || getVehicleColor(picked.vehicleId) !== carManager.getColor()) switchVehicle(picked.vehicleId);
      else if (!sameTyreSetup(getTyreSetup(picked.vehicleId), carManager.getVehicle()?.tyreSetup)) carManager.setTyreSetup(getTyreSetup(picked.vehicleId));
      await startPlan(picked.plan);
      newCar();
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
      // Single stage: a fresh run (from its picked time again); rally: the current stage again, the clock back to when it began.
      const index = plan.kind === 'stage' ? 0 : itemIndex;
      await startPlan(plan, index, plan.kind === 'stage' ? [] : results, 'teleport', null, services, plan.kind === 'stage' ? null : itemMark);
      if (plan.kind === 'stage') newCar();
    } finally {
      busy = false;
    }
  }

  /** The current item's first point and the straight-line metres to it when the drive there can be skipped (a rally, not yet on the stage, far enough), else null. */
  function skipTarget() {
    if (plan?.kind !== 'rally' || finished || busy || !screenFade) return null;
    if (run && (run.state.phase !== 'approach' || run.state.next > 0)) return null;
    const target = itemPoints(currentItem())[0];
    const pos = carPosition();
    if (!target || !pos || !addressSearch.canTeleport()) return null;
    const { x, z } = viewFrame.fromLatLon(target.lat, target.lon);
    const metres = Math.hypot(x - pos.x, z - pos.z);
    return metres > SKIP_LIAISON_M ? { target, metres } : null;
  }

  /** Skips the liaison drive, burning its fuel: fade to black, the car placed before the next point, fade back in. */
  async function skipLiaison() {
    const skip = skipTarget();
    if (!skip) return;
    const vehicle = carManager.getVehicle();
    // Fuel and cans are checked by the litres below, not as wear; paint and dirt are cosmetic.
    const worn = vehicle ? carParts(vehicle).find((p) => p.group !== 'Fuel & spares' && p.group !== 'Body' && p.level != null && p.level < SKIP_MIN_PART_LEVEL) : null;
    if (worn) {
      const flat = vehicle.wheelInfos?.some((w) => w.punctured);
      const rim = vehicle.wheelInfos?.some((w) => w.rimBroken);
      flash = { text: `Can't skip: ${flat ? 'flat tyre' : rim ? 'broken rim' : `${worn.label.toLowerCase()} too damaged`}`, until: simTime + SPLIT_SHOW_S };
      return;
    }
    const fuel = vehicle?.fuel;
    const litres = fuel?.skippedDriveLitres(skip.metres * SKIP_ROAD_FACTOR) ?? 0;
    if (fuel && litres > fuel.litres) {
      flash = { text: `Not enough fuel to skip: ${formatVolume(litres)} needed`, until: simTime + SPLIT_SHOW_S };
      return;
    }
    busy = true;
    try {
      const item = currentItem();
      const ss = plan.items.slice(0, itemIndex + 1).filter((i) => i.type === 'stage').length;
      const to = item.type === 'stage' ? `SS${ss} · ${item.stage.name}` : pointLabel(item.point.type).toLowerCase();
      const used = `${formatDistance(skip.metres * SKIP_ROAD_FACTOR)} · ${formatVolume(litres)} fuel`;
      routeGuidance.stop();
      await screenFade.out(`Liaison to ${to}\n${used}`);
      if (await spawnAt(itemIndex, { quiet: true, fromBase: false })) {
        while (carManager.isResetting()) await new Promise(requestAnimationFrame);
        fuel?.setLitres(fuel.litres - litres);
        conditions.advance(((skip.metres * SKIP_ROAD_FACTOR) / (SKIP_SPEED_KMH / 3.6)) * 1000);
        flash = { text: `Liaison skipped: ${used}`, until: simTime + SPLIT_SHOW_S };
        snapCamera?.();
      }
    } finally {
      busy = false;
      screenFade.in();
    }
  }

  /** True once the distance to target `key` has kept growing for WRONG_WAY_S. */
  function wrongWay(key, dist) {
    if (dist == null || busy) return (away = null), false;
    if (away?.key !== key || Math.abs(dist - away.dist) > JUMP_GUARD_M) away = { key, dist, time: simTime, s: 0 };
    const dt = simTime - away.time;
    if (dt <= 0) return away.s >= WRONG_WAY_S;
    const rate = (dist - away.dist) / dt;
    if (rate > WRONG_WAY_RATE) away.s += dt;
    else if (rate < -WRONG_WAY_RATE) away.s = 0;
    away.dist = dist;
    away.time = simTime;
    return away.s >= WRONG_WAY_S;
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
    const wrong = state.phase !== 'countdown' && wrongWay(`${itemIndex}|${state.next}`, next ? dist : null);
    // Only the live stage gets the big centre warning; off it, the status line says so.
    const onStage = state.phase === 'running';
    if (wrong && !onStage) status = WRONG_WAY_TEXT;
    if (flash && simTime < flash.until) status = flash.text;
    return {
      title: `SS${ss} · ${stage.name}`,
      clockMs: state.startTime == null ? (state.phase === 'countdown' ? 0 : null) : run.elapsedMs(),
      lights: state.phase === 'countdown' || run.lights().green ? run.lights() : null,
      status,
      next: next && dist != null && state.phase !== 'countdown' ? `Next: ${pointLabel(next.type)} · ${formatDistance(dist)}` : '',
      warning: wrong && onStage ? WRONG_WAY_TEXT : '',
      penaltyMs: run.penaltyMs(),
      buttons: [...(stopped && onInspect ? ['inspect'] : []), ...(skipTarget() ? ['skipLiaison'] : []), ...(run.isLive() ? ['retire'] : [])],
    };
  }

  function resultsView() {
    if (!resultRows) {
      const rows = [];
      const leader = worldTop?.rows?.[0];
      if (plan.kind === 'stage') {
        const r = results[results.length - 1];
        r?.splits.forEach((ms, i) => {
          const first = leader?.splits?.[i];
          rows.push([`Split ${i + 1}`, `${formatTime(ms)}${first != null ? `  ${formatDelta(ms - first)}` : ''}`]);
        });
        if (r?.penaltyMs) rows.push(['Penalty', `+${formatTime(r.penaltyMs)}`]);
        rows.push(['Stage time', r?.ms == null ? 'DNF' : formatTime(r.ms), 'total']);
        if (r?.best) rows.push(['Your best', formatTime(r.best.totalMs)]);
        else if (r?.ms != null) rows.push(['Your best', 'New best!']);
        rows.push(...damageRows());
      } else {
        const dnf = results.some((r) => r.ms == null);
        const late = servicePenaltyMs();
        if (late) rows.push(['Late from service', `+${formatTime(late)}`]);
        rows.push(['Rally time', dnf ? 'DNF' : formatTime(rallyTotalMs()), 'total']);
      }
      rows.push(...worldRows());
      resultRows = rows;
    }
    return {
      title: plan.kind === 'stage' ? `${plan.name} · finished` : `${plan.name} · rally finished`,
      results: resultRows,
      buttons: plan.kind === 'stage' ? ['restart', 'pick', 'mainMenu'] : ['newRally', 'mainMenu'],
    };
  }

  /** The car's damaged parts after a single stage (lib/serviceRepairs.js verdicts). */
  function damageRows() {
    const vehicle = carManager.getVehicle();
    if (!vehicle) return [];
    const damaged = carParts(vehicle).filter(
      (p) => p.group !== 'Fuel & spares' && (p.verdict === 'bad' || (p.verdict === 'warn' && (p.level == null || p.level < DAMAGE_SHOWN_LEVEL))),
    );
    const rows = damaged.map((p) => [p.group === 'Tyres' ? `Tyre · ${p.label}` : p.label, p.note, p.verdict]);
    return [['Car damage', rows.length ? '' : 'none', 'head'], ...rows];
  }

  function onlineRank(entry) {
    if (!entry) return 'Sending…';
    if (entry.error) return entry.error;
    return entry.rank ? `${entry.rank} / ${entry.count} · ${getVehicle(entry.vehicle).name}` : '-';
  }

  /** The world top times, the player's own row marked (and added below when outside them). */
  function worldRows() {
    if (!worldTop) return [];
    const failed = results.map((r) => online.get(r)?.error).find(Boolean);
    if (failed) return [['World times', failed]];
    if (worldTop.loading) return [['World times', 'Loading…']];
    if (worldTop.error) return [['World times', worldTop.error]];
    const { rows, myHash } = worldTop;
    if (!rows.length) return [['World times', 'none yet']];
    const line = (row, i) => [`${i + 1}. ${row.name} · ${vehicleLabel(row.vehicle)}`, formatTime(row.totalMs), row.player === myHash ? 'mine' : ''];
    const out = [[`World top ${WORLD_TOP_N}`, '', 'head'], ...rows.slice(0, WORLD_TOP_N).map(line)];
    const mine = rows.findIndex((row) => row.player === myHash);
    if (mine >= WORLD_TOP_N) out.push(['…', ''], line(rows[mine], mine));
    return out;
  }

  /** Where an item stands: 'done', 'current' or ''. */
  const itemState = (i) => (finished || i < itemIndex ? 'done' : i === itemIndex ? 'current' : '');
  /** Where point j of the current stage stands. */
  const pointState = (i, j) => {
    const state = itemState(i);
    if (state !== 'current') return state;
    // No run yet while startPlan awaits the conditions: nothing driven.
    const next = run?.state.next ?? 0;
    return j < next ? 'done' : j === next ? 'current' : '';
  };

  /** Side panel: the itinerary, stage by stage. */
  function planView() {
    const rows = [];
    let ss = 0;
    let day = 0;
    plan.items.forEach((item, i) => {
      const state = itemState(i);
      if (item.type !== 'stage') {
        const visit = services[i];
        const value = !visit ? '' : visit.penaltyMs ? `+${formatTime(visit.penaltyMs)}` : `${visit.usedMin} min`;
        const type = rallyFormat.pointTypes[item.point.type];
        const icon = type?.service ? 'service' : type?.refuel ? 'refuel' : type?.tyres ? 'tyres' : type?.endsDay ? 'parc' : (NAMED_ICONS[item.point.type] ?? '');
        const endsDay = type?.endsDay && i < plan.items.length - 1;
        const label = endsDay ? `${pointLabel(item.point.type)} · end of day ${++day}` : pointLabel(item.point.type);
        rows.push({ label, value, state, icon, endsDay });
        return;
      }
      // Results hold one entry per stage driven, in itinerary order.
      const result = state === 'done' ? results[ss] : null;
      ss++;
      rows.push({ label: `SS${ss} ${item.stage.name}`, value: result ? (result.ms == null ? 'DNF' : formatTime(result.ms)) : '', state });
    });
    return { title: plan.name, rows };
  }

  /** Rally info dialog data (ui/rallyInfoDialog.js): conditions, itinerary with stage details, totals so far. */
  function rallyInfo() {
    const bests = readLocalBests();
    let ss = 0;
    let km = 0;
    const rows = plan.items.map((item, i) => {
      const state = itemState(i);
      if (item.type !== 'stage') {
        const visit = services[i];
        const value = !visit ? '' : `${visit.usedMin} min${visit.penaltyMs ? `, +${formatTime(visit.penaltyMs)}` : ''}`;
        return { state, label: pointLabel(item.point.type), km: '', splits: '', best: '', value };
      }
      const { stage } = item;
      const result = state === 'done' ? results[ss] : null;
      ss++;
      // Only pacenotes or the saved route measure the stage road.
      const length = stage.pacenotes?.length ?? stage.route?.length;
      if (length) km += length / 1000;
      const best = bests[bestKey(stage)];
      return {
        state,
        label: `SS${ss} ${stage.name}`,
        km: length ? longDistanceValue(length / 1000).toFixed(2) : '–',
        splits: String(stage.points.filter((p) => p.type === 'split').length),
        best: best ? formatTime(best.totalMs) : '',
        value: result ? (result.ms == null ? 'DNF' : `${formatTime(result.ms)}${result.penaltyMs ? ` (+${formatTime(result.penaltyMs)})` : ''}`) : '',
      };
    });
    const dnf = results.some((r) => r.ms == null);
    const stageMs = results.reduce((sum, r) => sum + (r.ms ?? 0), 0);
    const wetness = getWetness();
    const surface = wetness <= 0.05 ? 'Dry' : wetness < 0.4 ? 'Damp' : 'Wet';
    const rain = getRainMmH();
    return {
      title: plan.name,
      vehicle: getVehicle(getVehicleId()).name,
      conditions: [
        ...(plan.kind === 'rally' ? [['Day', String(conditions.getDay())]] : []),
        ['Time of day', formatClock(new Date(clockMs()))],
        ...(rain ? [['Rain', rain < 1 ? 'Light' : rain < 4 ? 'Moderate' : 'Heavy']] : []),
        ['Air temperature', formatTemp(getAirTempC())],
        ['Surface', surface],
      ],
      forecast: formatForecast(conditions.forecast(rallyDays()), conditions.displayMs, plan.kind === 'rally'),
      rows,
      totals: [
        ['Stages', `${results.length} / ${ss} driven`],
        ['Stage distance', km ? `${longDistanceValue(km).toFixed(2)} ${longDistanceUnit()}` : '–'],
        ['Stage times', results.length ? (dnf ? 'DNF' : formatTime(stageMs)) : '–'],
        ['Service penalties', servicePenaltyMs() ? `+${formatTime(servicePenaltyMs())}` : 'none'],
        ['Rally time', results.length ? (dnf ? 'DNF' : formatTime(rallyTotalMs())) : '–'],
      ],
    };
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
    const key = plan ? `${itemIndex}|${run?.state.next}|${finished}|${results.length}|${JSON.stringify(services)}` : '';
    if (shownProgress && key === shownProgress.key && plan === shownProgress.plan) return;
    shownProgress = { key, plan };
    planHud.render(plan?.kind === 'rally' ? planView() : null);
    onMapPoints?.(plan ? mapPoints() : []);
  }

  function view() {
    const v = baseView();
    if (plan?.kind === 'rally' && !finished && conditions.isRunning()) v.title = `${v.title}  ·  Day ${conditions.getDay()} ${formatClock(new Date(clockMs()))}`;
    return v;
  }

  function baseView() {
    if (!plan && busy) return { title: 'Rally', status: 'Choose a stage or rally' };
    // Loading failed: say why, and offer the picker again.
    if (!plan) return { title: 'Rally', status: flash?.text ?? '', buttons: ['pickAgain'] };
    if (finished) return resultsView();
    const item = currentItem();
    // startPlan awaits the conditions before showItem: no item / run for the new plan yet.
    if (!item || (item.type === 'stage' && !run)) return { title: plan.name, status: 'Loading…' };
    if (item.type === 'stage') return stageView(item);
    const gate = scenery.getGate(0);
    const pos = carPosition();
    const dist = gate && pos ? Math.hypot(gate.x - pos.x, gate.z - pos.z) : null;
    const wrong = wrongWay(`${itemIndex}`, dist);
    return {
      title: plan.name,
      status: flash && simTime < flash.until ? flash.text : wrong ? WRONG_WAY_TEXT : liaisonStatus(item.point.type, dist),
      next: dist == null ? '' : `${pointLabel(item.point.type)} · ${formatDistance(dist)}`,
      buttons: [...(stopped && onInspect ? ['inspect'] : []), ...(skipTarget() ? ['skipLiaison'] : [])],
    };
  }

  /** Notes from the countdown to the finish. */
  function pacenoteView() {
    const phase = run?.state.phase;
    const pos = carPosition();
    if (!pacenoteRun || !pos || busy || (phase !== 'countdown' && phase !== 'running')) return null;
    const speed = carManager.getVehicle()?.chassisBody.velocity.length() ?? 0;
    pacenoteRun.update(pos, phase === 'countdown', speed);
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
          initialPick.plan.conditions = initialPick.conditions;
          await startPlan(initialPick.plan, 0, [], 'place');
          newCar();
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
        const json = await opened.readJson(filePath(rallyFormat.folder, def, splitReverseKey(progress.id).key));
        if (!json) throw new Error(`${progress.id} is gone from ${progress.source}`);
        const saved = await buildPlan(progress.kind, progress.source, opened, progress.id, json);
        // The car resumes where it was saved (lib/carState.js), so it needs no spawn.
        await startPlan(saved, progress.itemIndex ?? 0, progress.results ?? [], null, progress.run ?? null, progress.services, progress.conditions ?? null);
        itemMark = progress.mark ?? itemMark;
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
      if (plan && !busy) conditions.tick(dt);
      const pos = carPosition();
      if (!pos || !plan || finished || busy) return;
      step.x = pos.x;
      step.z = pos.z;
      if (!prev || Math.hypot(step.x - prev.x, step.z - prev.z) > JUMP_GUARD_M) {
        prev = { x: step.x, z: step.z };
        refuelWaitM = null;
        return;
      }
      if (refuelWaitM !== null) {
        refuelWaitM += Math.hypot(step.x - prev.x, step.z - prev.z);
        if (refuelWaitM > REFUEL_WAIT_M) refuelWaitM = null;
        else if (carManager.getVehicle().chassisBody.velocity.length() < REFUEL_MENU_SPEED) {
          refuelWaitM = null;
          onRefuel?.();
        }
      }
      if (keepsProgress && simTime >= nextProgressSave) saveProgress();
      const item = currentItem();
      if (item.type === 'stage') {
        run?.step(dt, prev, step, carManager.getVehicle().chassisBody.velocity.length());
      } else {
        const gate = scenery.getGate(0);
        const dist = gate ? Math.hypot(step.x - gate.x, step.z - gate.z) : Infinity;
        const pointType = rallyFormat.pointTypes[item.point.type];
        const done = pointType?.stop
          ? dist < LIAISON_STOP_ZONE_M && carManager.getVehicle().chassisBody.velocity.length() < LIAISON_STOP_SPEED
          : dist < gate?.halfWidth + LIAISON_PASS_PAD_M;
        if (done) checkIn(item);
      }
      prev.x = step.x;
      prev.z = step.z;
    },

    /** Per frame: scenery, start lights, HUD. */
    update(dt) {
      scenery.update(dt, carPosition());
      picking?.update();
      fieldFix?.update();
      const speed = carManager.getVehicle()?.chassisBody.velocity.length() ?? Infinity;
      stopped = !busy && speed < (stopped ? INSPECT_HIDE_SPEED : INSPECT_SHOW_SPEED);
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
      const live = run?.state.phase === 'running';
      if (live !== stageLive) {
        stageLive = live;
        onStageLive?.(live);
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
      planHud.setClock(plan?.kind === 'rally' && conditions.isRunning() ? `Day ${conditions.getDay()} · ${formatClock(new Date(clockMs()))}` : '');
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
