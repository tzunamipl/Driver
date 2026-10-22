// Static map of a rally plan (app/rally/rallySession.js) for the stage / rally picker: OSM
// tiles fitted to the plan, the road route through every point (OSRM) with the timed
// sections (start -> finish) in red and liaisons dashed, plus markers: a rally's stages by
// their start, a single stage with all its controls.

import { lon2tileX, lat2tileY } from '../lib/geo.js';
import { fetchRouteVia } from '../lib/routing.js';
import { rallyFormat } from '../lib/scenarios/rally.js';
import { TILE_SIZE, createMapTileCache } from '../hud/mapTiles.js';

const MIN_ZOOM = 3;
const MAX_ZOOM = 16;
const FIT_PAD_PX = 28;
const SS_COLOR = '#e02020';
const LIAISON_COLOR = '#2f7cff';
// Locator inset (top-left): where on the continent the plan is.
const INSET_ZOOM = 3;
const INSET_W = 96;
const INSET_H = 72;
const INSET_MARGIN = 6;

const toMercX = (lon) => lon2tileX(lon, 0);
const toMercY = (lat) => lat2tileY(lat, 0);
const km = (m) => `${(m / 1000).toFixed(1)} km`;
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

const isSsLeg = (waypoints, i) => waypoints[i].ss && waypoints[i + 1].stage === waypoints[i].stage;

export function createRallyPlanMap() {
  const root = Object.assign(document.createElement('div'), { className: 'rally-plan-map' });
  const view = Object.assign(document.createElement('div'), { className: 'rally-plan-map-view' });
  const canvas = document.createElement('canvas');
  const attribution = Object.assign(document.createElement('div'), { className: 'rally-plan-map-attribution', textContent: '© OpenStreetMap contributors' });
  const info = Object.assign(document.createElement('div'), { className: 'rally-plan-map-info' });
  view.append(canvas, attribution);
  root.append(view, info);
  const ctx = canvas.getContext('2d');
  const tiles = createMapTileCache({ maxSize: 200, pruneTo: 120 });

  let plan = null;
  let waypoints = [];
  let route = null; // fetchRouteVia result for `waypoints`, null while loading / failed
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
    let ss = 0;
    for (let i = 0; i < route.legStarts.length; i++) {
      if (isSsLeg(waypoints, i)) ss += route.cum[legEnd(i)] - route.cum[route.legStarts[i]];
    }
    const stages = plan.items.filter((item) => item.type === 'stage').length;
    setInfo(
      plan.kind === 'rally'
        ? `${stages} stage${stages === 1 ? '' : 's'} · SS ${km(ss)} · total ${km(route.distance)}`
        : `Stage ${km(ss)}`
    );
  }

  /** @param {object | null} next - plan from rallySession's buildPlan; null clears the map. */
  function show(next, message = '') {
    const seq = ++showSeq;
    plan = next;
    waypoints = next ? planWaypoints(next) : [];
    route = null;
    setInfo(message);
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
    if (route) for (let i = 0; i < route.mx.length; i++) add(route.mx[i], route.my[i]);
    const span = Math.max((maxX - minX) / Math.max(1, widthCss - 2 * FIT_PAD_PX), (maxY - minY) / Math.max(1, heightCss - 2 * FIT_PAD_PX));
    const zoom = span > 0 ? Math.floor(Math.log2(1 / (span * TILE_SIZE))) : MAX_ZOOM;
    return { zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)), cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
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
      for (let i = 0; i < waypoints.length - 1; i++) {
        if (isSsLeg(waypoints, i) !== ss) continue;
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
      else drawDot(at(w), typeColor(w.type));
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
    ctx.fillStyle = '#aad3df';
    ctx.fill();
    ctx.save();
    ctx.clip();
    for (let ty = Math.floor(top / TILE_SIZE); ty <= Math.floor((top + INSET_H) / TILE_SIZE); ty++) {
      for (let tx = Math.floor(left / TILE_SIZE); tx <= Math.floor((left + INSET_W) / TILE_SIZE); tx++) {
        const entry = tiles.get(INSET_ZOOM, tx, ty);
        if (entry?.ready) ctx.drawImage(entry.img, tx * TILE_SIZE - left, ty * TILE_SIZE - top, TILE_SIZE, TILE_SIZE);
      }
    }
    ctx.restore();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#404040';
    ctx.strokeRect(0.5, 0.5, INSET_W - 1, INSET_H - 1);
    const x = cx * world - left;
    const y = cy * world - top;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = SS_COLOR;
    ctx.stroke();
    drawDot({ x, y }, SS_COLOR);
    ctx.restore();
  }

  function draw() {
    const dpr = resize();
    if (!widthCss || !heightCss) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#e9e6df';
    ctx.fillRect(0, 0, widthCss, heightCss);
    if (!waypoints.length) return;

    const { zoom, cx, cy } = fit();
    const world = TILE_SIZE * 2 ** zoom;
    const left = cx * world - widthCss / 2;
    const top = cy * world - heightCss / 2;
    const x0 = Math.floor(left / TILE_SIZE);
    const y0 = Math.floor(top / TILE_SIZE);
    const x1 = Math.floor((left + widthCss) / TILE_SIZE);
    const y1 = Math.floor((top + heightCss) / TILE_SIZE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const entry = tiles.get(zoom, tx, ty);
        if (entry?.ready) ctx.drawImage(entry.img, tx * TILE_SIZE - left, ty * TILE_SIZE - top, TILE_SIZE, TILE_SIZE);
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
