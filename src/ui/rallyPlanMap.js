// Static map of a rally plan (app/rally/rallySession.js) for the stage / rally picker: OSM
// tiles fitted to the plan, the road route through every point (OSRM) with the timed
// sections (start -> finish) in red - a stage's saved route where it has one - and liaisons dashed, plus markers: a rally's stages by
// their start, a single stage with all its controls. Below it the timed roads' surface shares.

import { lon2tileX, lat2tileY } from '../lib/geo.js';
import { fetchRouteVia } from '../lib/routing.js';
import { rallyFormat } from '../lib/scenarios/rally.js';
import { TILE_SIZE, createMapTileCache } from '../hud/mapTiles.js';
import { longDistanceValue, longDistanceUnit } from '../lib/units.js';
import { stageSurfaceMetres } from '../lib/rally/pacenotes.js';
import { STAGE_SURFACES } from '../lib/rally/stageSurfaces.js';

const MIN_ZOOM = 3;
const MAX_ZOOM = 16;
// Share of the free map area left empty on each side of the fitted plan.
const FIT_MARGIN = 0.1;
const SS_COLOR = '#e02020';
const LIAISON_COLOR = '#2f7cff';
// Locator inset (top-left): where on the continent the plan is.
const INSET_ZOOM = 1;
const INSET_W = 64;
const INSET_H = 48;
const INSET_SEA = [31, 74, 122];
// OSM Standard's water colour; pixels near it read as sea, the rest as white land.
const OSM_WATER = [170, 211, 223];
const INSET_MARGIN = 6;
// The plan fits right of the world inset, unless that leaves it narrower than this.
const MIN_PLAN_W = 160;

const toMercX = (lon) => lon2tileX(lon, 0);
const toMercY = (lat) => lat2tileY(lat, 0);
const km = (m) => `${longDistanceValue(m / 1000).toFixed(1)} ${longDistanceUnit()}`;

/** The tile as a two-tone locator: dark sea, white land (blended over the coast's antialiasing). */
function recolorInsetTile(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const c = canvas.getContext('2d');
  c.drawImage(img, 0, 0);
  const data = c.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const d = Math.hypot(px[i] - OSM_WATER[0], px[i + 1] - OSM_WATER[1], px[i + 2] - OSM_WATER[2]);
    const land = Math.min(1, Math.max(0, (d - 12) / 36));
    for (let k = 0; k < 3; k++) px[i + k] = INSET_SEA[k] + (255 - INSET_SEA[k]) * land;
    px[i + 3] = 255;
  }
  c.putImageData(data, 0, 0);
  return canvas;
}
const hex = (color) => `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
const typeColor = (type) => hex(rallyFormat.pointTypes[type]?.color ?? 0x808080);

// Routes per waypoint list, so re-selecting a plan doesn't refetch.
const routeCache = new Map();

function fetchCached(waypoints) {
  const key = waypoints.map((w) => `${w.lon},${w.lat}`).join(';');
  if (!routeCache.has(key)) {
    const pending = fetchRouteVia(waypoints);
    pending.catch(() => routeCache.delete(key));
    routeCache.set(key, pending);
  }
  return routeCache.get(key);
}

/**
 * Plan points in driving order: { lat, lon, type, stage (index, -1 = liaison point), ss }.
 * `ss`: the leg after this point is timed (from the start up to the finish).
 */
function planWaypoints(plan) {
  const out = [];
  if (plan.base) out.push({ lat: plan.base.lat, lon: plan.base.lon, type: 'base', stage: -1, ss: false });
  let stage = 0;
  for (const item of plan.items) {
    if (item.type !== 'stage') {
      out.push({ lat: item.point.lat, lon: item.point.lon, type: item.point.type, stage: -1, ss: false });
      continue;
    }
    const points = item.stage.points;
    const start = points.findIndex((p) => p.type === 'start');
    const finish = points.findIndex((p) => p.type === 'finish');
    points.forEach((p, i) => out.push({ lat: p.lat, lon: p.lon, type: p.type, stage, ss: i >= start && i < finish }));
    stage++;
  }
  return out;
}

// Surface metres per stage (points + sections), so re-selecting a plan doesn't refetch its roads.
const surfaceCache = new Map();

function surfaceMetresCached(stage) {
  const key = JSON.stringify([stage.points.map((p) => [p.lat, p.lon, p.type, !!p.straight]), stage.surfaces ?? []]);
  if (!surfaceCache.has(key)) {
    const pending = stageSurfaceMetres(stage.points, stage.surfaces ?? [], stage.route);
    pending.catch(() => surfaceCache.delete(key));
    surfaceCache.set(key, pending);
  }
  return surfaceCache.get(key);
}

/** Every stage's surface metres summed: { id: metres }. */
async function planSurfaceMetres(plan) {
  const total = {};
  const stages = plan.items.filter((item) => item.type === 'stage');
  for (const metres of await Promise.all(stages.map((item) => surfaceMetresCached(item.stage)))) {
    for (const [id, m] of Object.entries(metres)) total[id] = (total[id] ?? 0) + m;
  }
  return total;
}

const isSsLeg = (waypoints, i) => waypoints[i].ss && waypoints[i + 1].stage === waypoints[i].stage;

/** Each stage's saved route (lib/rally/savedRoute.js) as { mx, my, length }, null without one; by stage index. */
const savedLines = (plan) =>
  plan.items
    .filter((item) => item.type === 'stage')
    .map(({ stage: { route } }) =>
      route ? { mx: route.points.map(([, lon]) => toMercX(lon)), my: route.points.map(([lat]) => toMercY(lat)), length: route.length } : null
    );

export function createRallyPlanMap() {
  const root = Object.assign(document.createElement('div'), { className: 'rally-plan-map' });
  const view = Object.assign(document.createElement('div'), { className: 'rally-plan-map-view' });
  const canvas = document.createElement('canvas');
  const attribution = Object.assign(document.createElement('div'), { className: 'rally-plan-map-attribution', textContent: '© OpenStreetMap contributors' });
  const info = Object.assign(document.createElement('div'), { className: 'rally-plan-map-info' });
  const surfaces = Object.assign(document.createElement('div'), { className: 'rally-plan-surfaces' });
  view.append(canvas, attribution);
  root.append(view, info, surfaces);
  const ctx = canvas.getContext('2d');
  const tiles = createMapTileCache({ maxSize: 200, pruneTo: 120 });
  const insetTiles = new WeakMap(); // tile entry -> recoloured canvas

  let plan = null;
  let waypoints = [];
  let route = null; // fetchRouteVia result for `waypoints`, null while loading / failed
  let saved = []; // savedLines(plan)
  let showSeq = 0;
  let rafId = 0;
  let widthCss = 0;
  let heightCss = 0;

  function setInfo(text) {
    info.textContent = text;
  }

  function describe() {
    if (!route) return;
    const legEnd = (i) => (i + 1 < route.legStarts.length ? route.legStarts[i + 1] : route.cum.length - 1);
    let ss = saved.reduce((sum, line) => sum + (line?.length ?? 0), 0);
    for (let i = 0; i < route.legStarts.length; i++) {
      if (isSsLeg(waypoints, i) && !saved[waypoints[i].stage]) ss += route.cum[legEnd(i)] - route.cum[route.legStarts[i]];
    }
    const stages = plan.items.filter((item) => item.type === 'stage').length;
    setInfo(
      plan.kind === 'rally'
        ? `${stages} stage${stages === 1 ? '' : 's'} · SS ${km(ss)} · total ${km(route.distance)}`
        : `Stage ${km(ss)}`
    );
  }

  function setSurfaces(metres) {
    const total = Object.values(metres ?? {}).reduce((sum, m) => sum + m, 0);
    if (!total) {
      surfaces.replaceChildren();
      return;
    }
    const shares = Object.entries(metres)
      .map(([id, m]) => ({ id, share: m / total }))
      .filter(({ share }) => share >= 0.005)
      .sort((a, b) => b.share - a.share);
    const bar = Object.assign(document.createElement('div'), { className: 'rally-plan-surfaces-bar' });
    const legend = Object.assign(document.createElement('div'), { className: 'rally-plan-surfaces-legend' });
    for (const { id, share } of shares) {
      const { label, color } = STAGE_SURFACES[id] ?? { label: id, color: '#808080' };
      const part = Object.assign(document.createElement('span'), { title: `${label} ${Math.round(share * 100)}%` });
      part.style.flexGrow = share;
      part.style.background = color;
      bar.append(part);
      const item = Object.assign(document.createElement('span'), { textContent: `${label} ${Math.round(share * 100)}%` });
      item.style.setProperty('--swatch', color);
      legend.append(item);
    }
    surfaces.replaceChildren(bar, legend);
  }

  /** @param {object | null} next - plan from rallySession's buildPlan; null clears the map. */
  function show(next, message = '') {
    const seq = ++showSeq;
    plan = next;
    waypoints = next ? planWaypoints(next) : [];
    saved = next ? savedLines(next) : [];
    route = null;
    setInfo(message);
    setSurfaces(null);
    if (next) {
      surfaces.textContent = 'Surfaces…';
      planSurfaceMetres(next).then(
        (metres) => {
          if (seq === showSeq) setSurfaces(metres);
        },
        (err) => {
          if (seq === showSeq) surfaces.textContent = `Surfaces unknown (${err.message})`;
        }
      );
    }
    if (waypoints.length < 2) return;
    setInfo('Routing…');
    fetchCached(waypoints).then(
      (result) => {
        if (seq !== showSeq) return;
        route = result;
        describe();
      },
      (err) => {
        if (seq === showSeq) setInfo(`No road route (${err.message}); straight lines shown`);
      }
    );
  }

  function resize() {
    const rect = view.getBoundingClientRect();
    widthCss = rect.width;
    heightCss = rect.height;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(widthCss * dpr);
    const h = Math.round(heightCss * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return dpr;
  }

  /** Zoom + centre (Mercator) fitting the waypoints and the route. */
  function fit() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const add = (mx, my) => {
      minX = Math.min(minX, mx);
      maxX = Math.max(maxX, mx);
      minY = Math.min(minY, my);
      maxY = Math.max(maxY, my);
    };
    for (const w of waypoints) add(toMercX(w.lon), toMercY(w.lat));
    for (const line of [route, ...saved]) if (line) for (let i = 0; i < line.mx.length; i++) add(line.mx[i], line.my[i]);
    const besideInset = INSET_MARGIN * 2 + INSET_W;
    const freeLeft = (widthCss - besideInset) * (1 - 2 * FIT_MARGIN) >= MIN_PLAN_W ? besideInset : 0;
    const freeW = widthCss - freeLeft;
    const fitW = freeW * (1 - 2 * FIT_MARGIN);
    const fitH = heightCss * (1 - 2 * FIT_MARGIN);
    const span = Math.max((maxX - minX) / Math.max(1, fitW), (maxY - minY) / Math.max(1, fitH));
    // Fractional, so the plan fills the area; tiles are scaled from the nearest level.
    const zoom = span > 0 ? Math.log2(1 / (span * TILE_SIZE)) : MAX_ZOOM;
    // screenX: where the plan's centre sits, mid-way across the free area.
    return { zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)), cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, screenX: freeLeft + freeW / 2 };
  }

  function strokeLine(points, ss) {
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    if (ss) {
      ctx.setLineDash([]);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = SS_COLOR;
      ctx.lineWidth = 4;
    } else {
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = LIAISON_COLOR;
      ctx.lineWidth = 3;
    }
    ctx.stroke();
  }

  function drawLegs(toScreen) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Liaisons first so the timed sections sit on top.
    for (const ss of [false, true]) {
      if (ss) {
        for (const line of saved) {
          if (line) strokeLine(Array.from(line.mx, (mx, v) => toScreen(mx, line.my[v])), true);
        }
      }
      for (let i = 0; i < waypoints.length - 1; i++) {
        if (isSsLeg(waypoints, i) !== ss || (ss && saved[waypoints[i].stage])) continue;
        const points = [];
        if (route) {
          const end = i + 1 < route.legStarts.length ? route.legStarts[i + 1] : route.mx.length - 1;
          for (let v = route.legStarts[i]; v <= end; v++) points.push(toScreen(route.mx[v], route.my[v]));
        } else {
          for (const w of [waypoints[i], waypoints[i + 1]]) points.push(toScreen(toMercX(w.lon), toMercY(w.lat)));
        }
        strokeLine(points, ss);
      }
    }
    ctx.restore();
  }

  function drawDot({ x, y }, color) {
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  function drawPill({ x, y }, text, color) {
    const w = ctx.measureText(text).width + 8;
    const h = 14;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h - 6, w, h, 3);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y - h / 2 - 6 + 0.5);
    drawDot({ x, y }, color);
  }

  function drawMarkers(toScreen) {
    const at = (w) => toScreen(toMercX(w.lon), toMercY(w.lat));
    const pills = [];
    let stageNo = 0;
    for (const w of waypoints) {
      if (w.type === 'base') pills.push([at(w), 'BASE', typeColor('base')]);
      else if (w.type === 'start') pills.push([at(w), plan.kind === 'rally' ? `SS${++stageNo}` : 'START', typeColor('start')]);
      else if (plan.kind === 'rally' && w.stage >= 0) continue; // a rally shows each stage by its start only
      else if (w.type === 'finish') pills.push([at(w), 'FINISH', typeColor('finish')]);
      else if (w.type !== 'passageControl') drawDot(at(w), typeColor(w.type));
    }
    ctx.save();
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [pos, text, color] of pills) drawPill(pos, text, color);
    ctx.restore();
  }

  function drawInset(cx, cy) {
    const world = TILE_SIZE * 2 ** INSET_ZOOM;
    const left = cx * world - INSET_W / 2;
    // Keep the inset inside the map vertically (x wraps).
    const top = Math.min(world - INSET_H, Math.max(0, cy * world - INSET_H / 2));
    ctx.save();
    ctx.translate(INSET_MARGIN, INSET_MARGIN);
    ctx.beginPath();
    ctx.rect(0, 0, INSET_W, INSET_H);
    ctx.fillStyle = `rgb(${INSET_SEA})`;
    ctx.fill();
    ctx.save();
    ctx.clip();
    for (let ty = Math.floor(top / TILE_SIZE); ty <= Math.floor((top + INSET_H) / TILE_SIZE); ty++) {
      for (let tx = Math.floor(left / TILE_SIZE); tx <= Math.floor((left + INSET_W) / TILE_SIZE); tx++) {
        const entry = tiles.get(INSET_ZOOM, tx, ty);
        if (!entry?.ready) continue;
        if (!insetTiles.has(entry)) insetTiles.set(entry, recolorInsetTile(entry.img));
        ctx.drawImage(insetTiles.get(entry), tx * TILE_SIZE - left, ty * TILE_SIZE - top, TILE_SIZE, TILE_SIZE);
      }
    }
    ctx.restore();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#404040';
    ctx.strokeRect(0.5, 0.5, INSET_W - 1, INSET_H - 1);
    const x = cx * world - left;
    const y = cy * world - top;
    // Crosshair: four arms around a gap, with a single point in the middle.
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(x + dx * 2.5, y + dy * 2.5);
      ctx.lineTo(x + dx * 7, y + dy * 7);
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = SS_COLOR;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 1, 0, Math.PI * 2);
    ctx.fillStyle = SS_COLOR;
    ctx.fill();
    ctx.restore();
  }

  function draw() {
    const dpr = resize();
    if (!widthCss || !heightCss) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#e9e6df';
    ctx.fillRect(0, 0, widthCss, heightCss);
    if (!waypoints.length) return;

    const { zoom, cx, cy, screenX } = fit();
    const world = TILE_SIZE * 2 ** zoom;
    const left = cx * world - screenX;
    const top = cy * world - heightCss / 2;
    const tileZoom = Math.round(zoom);
    const tileSize = TILE_SIZE * 2 ** (zoom - tileZoom);
    const x0 = Math.floor(left / tileSize);
    const y0 = Math.floor(top / tileSize);
    const x1 = Math.floor((left + widthCss) / tileSize);
    const y1 = Math.floor((top + heightCss) / tileSize);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const entry = tiles.get(tileZoom, tx, ty);
        // Rounded edges avoid hairline seams between scaled tiles.
        const sx = Math.round(tx * tileSize - left);
        const sy = Math.round(ty * tileSize - top);
        if (entry?.ready) ctx.drawImage(entry.img, sx, sy, Math.round((tx + 1) * tileSize - left) - sx, Math.round((ty + 1) * tileSize - top) - sy);
      }
    }
    tiles.prune();

    const toScreen = (mx, my) => ({ x: mx * world - left, y: my * world - top });
    drawLegs(toScreen);
    drawMarkers(toScreen);
    drawInset(cx, cy);
  }

  function frame() {
    draw();
    rafId = requestAnimationFrame(frame);
  }

  return {
    el: root,
    show,
    start() {
      if (!rafId) rafId = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(rafId);
      rafId = 0;
    },
  };
}
