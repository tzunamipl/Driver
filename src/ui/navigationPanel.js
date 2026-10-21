import { lon2tileX, lat2tileY, tileX2lon, tileY2lat } from '../lib/geo.js';
import { TILE_SIZE, createMapTileCache, formatCoords } from '../hud/mapTiles.js';
import { strokeRoute } from '../hud/routeLine.js';
import { readSaveField, writeSaveField } from '../lib/saves.js';

// Foldable "Navigation" tab: address search + a pannable slippy map to pick
// a destination, then Teleport or Navigate (road route) there. Map state is in
// normalised Web Mercator (0..1), so zooming needs no re-projection.

const MIN_ZOOM = 2;
const MAX_ZOOM = 19;
const OPEN_ZOOM = 14;
const RESULT_MAX_ZOOM = 17;
// Pointer travel (px) after which a press counts as a drag, not a click.
const DRAG_THRESHOLD_PX = 4;

const toMercX = (lon) => lon2tileX(lon, 0);
const toMercY = (lat) => lat2tileY(lat, 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function loadSelection() {
  const parsed = readSaveField('navDestination');
  if (!Number.isFinite(parsed?.lat) || !Number.isFinite(parsed?.lon)) return null;
  return { lat: parsed.lat, lon: parsed.lon, label: typeof parsed.label === 'string' ? parsed.label : null };
}

function saveSelection(selection) {
  writeSaveField('navDestination', selection);
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./addressSearch.js').createAddressSearch>} deps.addressSearch
 * @param {() => ({ lat: number, lon: number } | null)} deps.getCarLatLon
 * @param {ReturnType<import('../app/routeGuidance.js').createRouteGuidance>} deps.routeGuidance
 * @param {(selection: { lat: number, lon: number, label: string | null }) => void} [deps.onSelectionChange]
 */
export function createNavigationPanel({ addressSearch, getCarLatLon, routeGuidance, onSelectionChange }) {
  const panel = document.getElementById('nav-panel');
  const toggle = document.getElementById('nav-toggle');
  const form = document.getElementById('nav-search');
  const input = document.getElementById('nav-input');
  const searchBtn = document.getElementById('nav-search-submit');
  const resultsEl = document.getElementById('nav-results');
  const mapEl = document.getElementById('nav-map');
  const canvas = document.getElementById('nav-map-canvas');
  const zoomInBtn = document.getElementById('nav-zoom-in');
  const zoomOutBtn = document.getElementById('nav-zoom-out');
  const centerCarBtn = document.getElementById('nav-center-car');
  const selectionEl = document.getElementById('nav-selection');
  const teleportBtn = document.getElementById('nav-teleport');
  const navigateBtn = document.getElementById('nav-navigate');
  if (!panel || !canvas) return {};

  const ctx = canvas.getContext('2d');
  const tiles = createMapTileCache();
  let zoom = OPEN_ZOOM;
  let cx = 0.5;
  let cy = 0.5;
  let centredOnce = false;
  /** @type {{ lat: number, lon: number, label: string } | null} */
  let selection = null;
  let reverseSeq = 0;
  let rafId = 0;
  let widthCss = 0;
  let heightCss = 0;

  const worldPx = () => TILE_SIZE * 2 ** zoom;

  function isOpen() {
    return !panel.classList.contains('collapsed');
  }

  function setOpen(open) {
    panel.classList.toggle('collapsed', !open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      if (!centredOnce && !selection) centreOnCar();
      centredOnce = true;
      if (!rafId) rafId = requestAnimationFrame(frame);
    }
  }

  toggle.addEventListener('click', () => setOpen(!isOpen()));

  function centreOn(lat, lon, z = zoom) {
    zoom = clamp(Math.round(z), MIN_ZOOM, MAX_ZOOM);
    cx = toMercX(lon);
    cy = clamp(toMercY(lat), 0, 1);
  }

  function centreOnCar() {
    const car = getCarLatLon();
    if (car) centreOn(car.lat, car.lon, Math.max(zoom, OPEN_ZOOM));
  }

  // Largest zoom whose view still holds the [south, north, west, east] box.
  function fitBbox([south, north, west, east]) {
    const spanX = Math.abs(toMercX(east) - toMercX(west));
    const spanY = Math.abs(toMercY(south) - toMercY(north));
    const fit = Math.min(
      spanX > 0 ? Math.log2(widthCss / (spanX * TILE_SIZE)) : MAX_ZOOM,
      spanY > 0 ? Math.log2(heightCss / (spanY * TILE_SIZE)) : MAX_ZOOM
    );
    return clamp(Math.floor(fit), MIN_ZOOM, RESULT_MAX_ZOOM);
  }

  // ---------- Selection ----------
  function select(lat, lon, label) {
    const moved = selection?.lat !== lat || selection?.lon !== lon;
    selection = { lat, lon, label };
    // A new pin while navigating replaces the route.
    if (moved && routeGuidance.isNavigating()) routeGuidance.start(selection);
    selectionEl.textContent = label ? `${label} (${formatCoords(lat, lon)})` : formatCoords(lat, lon);
    saveSelection(selection);
    onSelectionChange?.(selection);
  }

  function selectPoint(lat, lon) {
    select(lat, lon, null);
    for (const li of resultsEl.children) li.classList.remove('is-selected');
    const seq = ++reverseSeq;
    addressSearch
      .reverseGeocode(lat, lon)
      .then((name) => {
        if (seq === reverseSeq && name) select(lat, lon, name);
      })
      .catch(() => {
        // Coordinates alone are fine.
      });
  }

  function selectResult(result, li) {
    reverseSeq++;
    select(result.lat, result.lon, result.label);
    centreOn(result.lat, result.lon, result.bbox ? fitBbox(result.bbox) : RESULT_MAX_ZOOM);
    for (const el of resultsEl.children) el.classList.toggle('is-selected', el === li);
  }

  const saved = loadSelection();
  if (saved) {
    select(saved.lat, saved.lon, saved.label);
    centreOn(saved.lat, saved.lon);
  }

  // ---------- Search ----------
  let searchSeq = 0;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) return;
    const seq = ++searchSeq;
    searchBtn.disabled = true;
    resultsEl.replaceChildren(statusItem('Searching…'));
    try {
      const results = await addressSearch.geocode(query);
      if (seq !== searchSeq) return;
      resultsEl.replaceChildren(
        ...results.map((result) => {
          const li = document.createElement('li');
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = result.label;
          btn.addEventListener('click', () => selectResult(result, li));
          li.append(btn);
          return li;
        })
      );
      selectResult(results[0], resultsEl.firstElementChild);
    } catch (err) {
      if (seq === searchSeq) resultsEl.replaceChildren(statusItem(`No results: ${err.message}`, true));
    } finally {
      if (seq === searchSeq) searchBtn.disabled = false;
    }
  });

  function statusItem(text, isError = false) {
    const li = document.createElement('li');
    li.className = isError ? 'nav-results-status is-error' : 'nav-results-status';
    li.textContent = text;
    return li;
  }

  // ---------- Map interaction ----------
  let press = null; // { id, x, y, cx, cy, dragging }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, cx, cy, dragging: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!press.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    press.dragging = true;
    mapEl.classList.add('is-dragging');
    cx = press.cx - dx / worldPx();
    cy = clamp(press.cy - dy / worldPx(), 0, 1);
  });
  function endPress(e, cancelled) {
    if (!press || e.pointerId !== press.id) return;
    if (!press.dragging && !cancelled) {
      const { mx, my } = pointerToMerc(e);
      // The map wraps sideways: a copy of the world past the seam must still give lon in -180..180.
      selectPoint(tileY2lat(clamp(my, 0, 1), 0), tileX2lon(mx - Math.floor(mx), 0));
    }
    press = null;
    mapEl.classList.remove('is-dragging');
  }
  canvas.addEventListener('pointerup', (e) => endPress(e, false));
  canvas.addEventListener('pointercancel', (e) => endPress(e, true));

  function pointerToMerc(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      mx: cx + (e.clientX - rect.left - widthCss / 2) / worldPx(),
      my: cy + (e.clientY - rect.top - heightCss / 2) / worldPx(),
    };
  }

  // Zoom keeping the point under the cursor (or the centre) fixed.
  function zoomBy(step, e) {
    const next = clamp(zoom + step, MIN_ZOOM, MAX_ZOOM);
    if (next === zoom) return;
    const rect = canvas.getBoundingClientRect();
    const ox = e ? e.clientX - rect.left - widthCss / 2 : 0;
    const oy = e ? e.clientY - rect.top - heightCss / 2 : 0;
    const mx = cx + ox / worldPx();
    const my = cy + oy / worldPx();
    zoom = next;
    cx = mx - ox / worldPx();
    cy = clamp(my - oy / worldPx(), 0, 1);
  }

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1 : -1, e);
    },
    { passive: false }
  );
  zoomInBtn.addEventListener('click', () => zoomBy(1));
  zoomOutBtn.addEventListener('click', () => zoomBy(-1));
  centerCarBtn.addEventListener('click', centreOnCar);

  // ---------- Actions ----------
  teleportBtn.addEventListener('click', async () => {
    // Drop focus so Space (handbrake) doesn't re-press the button.
    teleportBtn.blur();
    if (!selection) return;
    const { lat, lon, label } = selection;
    setOpen(false);
    await addressSearch.teleport(lat, lon, label ?? formatCoords(lat, lon));
  });
  navigateBtn.addEventListener('click', () => {
    navigateBtn.blur();
    if (routeGuidance.isNavigating()) {
      routeGuidance.stop();
      return;
    }
    if (!selection) return;
    setOpen(false);
    routeGuidance.start(selection);
  });

  function updateNavigateButton() {
    const { status } = routeGuidance.getState();
    const navigating = status === 'active' || status === 'loading';
    navigateBtn.disabled = !navigating && !selection;
    navigateBtn.classList.toggle('is-navigating', navigating);
    const label = status === 'loading' ? 'Routing\u2026' : navigating ? 'Stop' : 'Navigate';
    if (navigateBtn.textContent !== label) navigateBtn.textContent = label;
  }

  // ---------- Drawing ----------
  function resize() {
    const rect = mapEl.getBoundingClientRect();
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

  function draw() {
    const dpr = resize();
    if (!widthCss || !heightCss) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#e9e6df';
    ctx.fillRect(0, 0, widthCss, heightCss);

    const world = worldPx();
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

    const { route, progress } = routeGuidance.getState();
    if (route) {
      // Same world copy as the markers below.
      const wrap = Math.round(cx - route.mx[0]);
      strokeRoute(ctx, route, progress, left / world - wrap, top / world, world, 5);
    }

    // Markers wrap to the copy of the world nearest the view centre.
    const toScreen = (lat, lon) => {
      let mx = toMercX(lon);
      mx += Math.round(cx - mx);
      return { x: mx * world - left, y: toMercY(lat) * world - top };
    };

    const car = getCarLatLon();
    if (car) {
      const { x, y } = toScreen(car.lat, car.lon);
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#2f7cff';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    if (selection) drawPin(toScreen(selection.lat, selection.lon));
  }

  function drawPin({ x, y }) {
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-4, -10, -11, -14, -11, -22);
    ctx.arc(0, -22, 11, Math.PI, 0);
    ctx.bezierCurveTo(11, -14, 4, -10, 0, 0);
    ctx.fillStyle = '#e53935';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 4;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.beginPath();
    ctx.arc(0, -22, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
  }

  function frame() {
    if (!isOpen()) {
      rafId = 0;
      return;
    }
    draw();
    teleportBtn.disabled = !selection || !addressSearch.canTeleport();
    updateNavigateButton();
    rafId = requestAnimationFrame(frame);
  }

  return { isOpen };
}
