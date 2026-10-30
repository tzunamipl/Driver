import { lon2tileX, lat2tileY, tileSizeMeters, haversineMeters } from '../lib/geo.js';
import { computeHeadingDeg } from '../lib/heading.js';
import { TILE_SIZE, createMapTileCache, formatCoords } from './mapTiles.js';
import { strokeRoute } from './routeLine.js';
import { STAGE_ROUTE_COLOR, REVERSE_ROUTE_COLOR } from '../lib/rally/stageRouteLine.js';
import { drawScenarioPoints } from './scenarioPointIcon.js';
import { formatRouteDistance, formatRouteDuration } from '../lib/routing.js';
import { isImperial, FT_PER_M, M_PER_MILE, formatPeerDistance } from '../lib/units.js';
import { MINIMAP_MIN_ZOOM, MINIMAP_MAX_ZOOM, MINIMAP_DEFAULT_ZOOM, MINIMAP_STORAGE_KEY } from '../config.js';

// Round, north-up street-map minimap (OSM tiles, see mapTiles.js). The
// car marker rotates; the map doesn't. Zoom via wheel/buttons (persisted) with a scale bar. Shows
// coordinates and a place name from Nominatim reverse geocoding, heavily
// throttled per its usage policy.

function clampZoom(z) {
  return Math.min(MINIMAP_MAX_ZOOM, Math.max(MINIMAP_MIN_ZOOM, z));
}

function loadStoredZoom(storageKey, defaultZoom) {
  const raw = Number(localStorage.getItem(storageKey));
  return Number.isFinite(raw) && raw > 0 ? clampZoom(raw) : defaultZoom;
}

// "Nice" round distances (meters) considered for the scale bar.
const SCALE_STEPS_M = [
  5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000, 20_000, 25_000, 50_000, 100_000, 200_000,
].map((m) => ({ m, label: m >= 1000 ? `${m / 1000} km` : `${m} m` }));
const SCALE_STEPS_IMPERIAL = [
  ...[20, 50, 100, 200, 500, 1000, 2000].map((ft) => ({ m: ft / FT_PER_M, label: `${ft} ft` })),
  ...[0.5, 1, 2, 5, 10, 20, 50, 100].map((mi) => ({ m: mi * M_PER_MILE, label: `${mi} mi` })),
];

// Place-name lookups: only after moving this far, and at most this often.
const REGEOCODE_MIN_INTERVAL_MS = 15_000;
const REGEOCODE_MIN_DISTANCE_M = 400;
// Nominatim address keys, most to least specific.
const PLACE_NAME_FIELDS = ['city', 'town', 'village', 'municipality', 'county', 'state'];

// Peer colors arrive as 0xRRGGBB integers (see net.js's sanitizeColor).
function colorToCss(color) {
  const n = Number.isInteger(color) ? color & 0xffffff : 0xffffff;
  return `#${n.toString(16).padStart(6, '0')}`;
}

// Matches the Navigation map's pin.
const DESTINATION_COLOR = '#e53935';

// Text nodes only touched when their content changes.
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/**
 * @param {object} [deps]
 * @param {() => import('../app/routeGuidance.js').RouteState} [deps.getRouteState]
 * @param {number} [deps.defaultZoom] - zoom until the player picks one.
 * @param {string} [deps.storageKey] - where the picked zoom is kept (per mode).
 */
export function createMinimapHud({ getRouteState, defaultZoom = MINIMAP_DEFAULT_ZOOM, storageKey = MINIMAP_STORAGE_KEY } = {}) {
  const root = document.getElementById('minimap');
  const canvas = document.getElementById('minimap-canvas');
  const arrowsCanvas = document.getElementById('minimap-arrows-canvas');
  const zoomInBtn = document.getElementById('minimap-zoom-in');
  const zoomOutBtn = document.getElementById('minimap-zoom-out');
  const scaleBarEl = document.getElementById('minimap-scale-bar');
  const scaleLabelEl = document.getElementById('minimap-scale-label');
  const placeEl = document.getElementById('minimap-place');
  const coordsEl = document.getElementById('minimap-coords');
  const routeEl = document.getElementById('minimap-route');
  const routeArrowEl = document.getElementById('minimap-route-arrow');
  const routeTurnEl = document.getElementById('minimap-route-turn');
  const routeTurnDistEl = document.getElementById('minimap-route-turn-dist');
  const routeSummaryEl = document.getElementById('minimap-route-summary');
  if (!root || !canvas) return { update() {}, setDestination() {}, setScenarioPoints() {}, setStageRoute() {} };

  const ctx = canvas.getContext('2d');
  // Off-screen peer arrows go on a click-through overlay canvas above the
  // zoom/scale chrome.
  const arrowsCtx = arrowsCanvas?.getContext('2d') ?? null;
  const tiles = createMapTileCache();
  let zoom = loadStoredZoom(storageKey, defaultZoom);
  // dialSizeCss = the #minimap box width; the canvas is larger by
  // arrowBand on each side so arrows can be drawn outside the dial.
  let dialSizeCss = 0;
  let sizeCss = 0;
  let arrowBand = 0;
  let dpr = 1;
  /** @type {{ lat: number, lon: number } | null} */
  let destination = null;
  /** Scenario editor points: { lat, lon, color, label, gate, selected }. */
  let scenarioPoints = [];
  let stageRoute = null;
  let reverseRoute = null;

  // Last successful lookup position, and an in-flight guard.
  let lastGeocodeLat = null;
  let lastGeocodeLon = null;
  let lastGeocodeAt = 0;
  let geocodeInFlight = false;

  function maybeUpdatePlaceName(lat, lon) {
    if (!placeEl || geocodeInFlight) return;
    const now = performance.now();
    if (now - lastGeocodeAt < REGEOCODE_MIN_INTERVAL_MS) return;
    if (lastGeocodeLat != null) {
      // Flat-earth estimate; fine for a "moved enough" check.
      const dLat = (lat - lastGeocodeLat) * 111_320;
      const dLon = (lon - lastGeocodeLon) * 111_320 * Math.cos((lat * Math.PI) / 180);
      if (Math.hypot(dLat, dLon) < REGEOCODE_MIN_DISTANCE_M) return;
    }
    lastGeocodeAt = now;
    lastGeocodeLat = lat;
    lastGeocodeLon = lon;
    geocodeInFlight = true;
    fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`,
      { headers: { Accept: 'application/json' } }
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const address = data?.address;
        if (!address) return;
        const name = PLACE_NAME_FIELDS.map((f) => address[f]).find(Boolean);
        if (name) placeEl.textContent = name;
      })
      .catch(() => {
        // Keep the last known name on failure.
      })
      .finally(() => {
        geocodeInFlight = false;
      });
  }

  function resize() {
    const rect = root.getBoundingClientRect();
    dialSizeCss = rect.width || root.clientWidth;
    // Decorations were tuned at 190px; see draw().
    const s = dialSizeCss / 190;
    arrowBand = 20 * s;
    sizeCss = dialSizeCss + arrowBand * 2;
    dpr = window.devicePixelRatio || 1;
    const px = Math.round(sizeCss * dpr);
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    canvas.style.width = `${sizeCss}px`;
    canvas.style.height = `${sizeCss}px`;
    if (arrowsCanvas && (arrowsCanvas.width !== px || arrowsCanvas.height !== px)) {
      arrowsCanvas.width = px;
      arrowsCanvas.height = px;
    }
    if (arrowsCanvas) {
      arrowsCanvas.style.width = `${sizeCss}px`;
      arrowsCanvas.style.height = `${sizeCss}px`;
    }
  }
  resize();
  window.addEventListener('resize', resize);

  function setZoom(z) {
    zoom = clampZoom(z);
    localStorage.setItem(storageKey, String(zoom));
  }

  zoomInBtn?.addEventListener('click', () => setZoom(zoom + 1));
  zoomOutBtn?.addEventListener('click', () => setZoom(zoom - 1));
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      setZoom(zoom + (e.deltaY < 0 ? 1 : -1));
    },
    { passive: false }
  );

  function updateScaleBar(metersPerPx) {
    if (!scaleBarEl || !scaleLabelEl) return;
    const targetPx = 56;
    const steps = isImperial() ? SCALE_STEPS_IMPERIAL : SCALE_STEPS_M;
    let chosen = steps[0];
    for (const step of steps) {
      if (step.m / metersPerPx <= targetPx) chosen = step;
      else break;
    }
    const barPx = Math.max(4, chosen.m / metersPerPx);
    scaleBarEl.style.width = `${barPx}px`;
    scaleLabelEl.textContent = chosen.label;
  }

  // Teardrop pin with its tip on (x, y).
  function drawPin(x, y, s) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-2.5, -6, -6.5, -8.5, -6.5, -13);
    ctx.arc(0, -13, 6.5, Math.PI, 0);
    ctx.bezierCurveTo(6.5, -8.5, 2.5, -6, 0, 0);
    ctx.fillStyle = DESTINATION_COLOR;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -13, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
  }

  function drawScenarioMarkers(txf, tyf, mapRadius, s) {
    const worldTiles = 2 ** zoom;
    drawScenarioPoints(
      ctx,
      scenarioPoints,
      (lat, lon) => {
        let dtx = lon2tileX(lon, zoom) - txf;
        dtx -= Math.round(dtx / worldTiles) * worldTiles;
        const x = dtx * TILE_SIZE;
        const y = (lat2tileY(lat, zoom) - tyf) * TILE_SIZE;
        return Math.hypot(x, y) > mapRadius + 6 * s ? null : { x, y };
      },
      s
    );
  }

  function draw(lat, lon, headingDeg, peers) {
    resize();
    // Hidden (Settings > HUD): no box to draw in, and a negative dial radius would throw.
    if (!dialSizeCss) return;
    const size = sizeCss;
    const center = size / 2;
    // Decorations were tuned at 190px; scale with the CSS size.
    const s = dialSizeCss / 190;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    if (arrowsCtx) {
      arrowsCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      arrowsCtx.clearRect(0, 0, size, size);
    }

    // Dial is the original puck size; arrowBand around it is transparent.
    const mapRadius = center - arrowBand;

    // Shadow + fill before clipping, so the shadow isn't clipped.
    ctx.save();
    ctx.beginPath();
    ctx.arc(center, center, mapRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#e9e6df';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 10 * s;
    ctx.shadowOffsetY = 2 * s;
    ctx.fill();
    ctx.restore();

    // Circular clip so the dial reads as a round GPS puck, not a square.
    ctx.save();
    ctx.beginPath();
    ctx.arc(center, center, mapRadius, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#e9e6df';
    ctx.fillRect(0, 0, size, size);

    const txf = lon2tileX(lon, zoom);
    const tyf = lat2tileY(lat, zoom);
    const centerTileX = Math.floor(txf);
    const centerTileY = Math.floor(tyf);
    const radiusTiles = Math.ceil(mapRadius / TILE_SIZE) + 1;

    // North-up: no map rotation.
    ctx.translate(center, center);

    for (let dy = -radiusTiles; dy <= radiusTiles; dy++) {
      for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
        const tileX = centerTileX + dx;
        const tileY = centerTileY + dy;
        const entry = tiles.get(zoom, tileX, tileY);
        const drawX = (tileX - txf) * TILE_SIZE;
        const drawY = (tileY - tyf) * TILE_SIZE;
        if (entry?.ready) {
          ctx.drawImage(entry.img, drawX, drawY, TILE_SIZE, TILE_SIZE);
        } else if (!entry) {
          ctx.fillStyle = '#e9e6df';
          ctx.fillRect(drawX, drawY, TILE_SIZE, TILE_SIZE);
        }
      }
    }

    const worldPx = TILE_SIZE * 2 ** zoom;
    // Wider under the stage route: shows where the two differ.
    if (reverseRoute) strokeRoute(ctx, reverseRoute, null, txf / 2 ** zoom, tyf / 2 ** zoom, worldPx, 6 * s, REVERSE_ROUTE_COLOR);
    if (stageRoute) strokeRoute(ctx, stageRoute, null, txf / 2 ** zoom, tyf / 2 ** zoom, worldPx, 3 * s, STAGE_ROUTE_COLOR);
    const routeState = getRouteState?.();
    if (routeState?.route) {
      strokeRoute(ctx, routeState.route, routeState.progress, txf / 2 ** zoom, tyf / 2 ** zoom, worldPx, 4 * s);
    }

    drawScenarioMarkers(txf, tyf, mapRadius, s);

    const metersPerPx = tileSizeMeters(zoom, lat) / TILE_SIZE;
    // Peers: local (x, z) metres straight to pixels (+x right, +z down).
    const edgeMargin = 16 * s;
    const visibleRadius = mapRadius - edgeMargin;
    const markers = peers.map((peer) => ({
      ...peer,
      px: peer.dx / metersPerPx,
      py: peer.dz / metersPerPx,
    }));
    if (destination) {
      // Mercator offset rather than local metres: the target may be far away.
      const worldTiles = 2 ** zoom;
      let dtx = lon2tileX(destination.lon, zoom) - txf;
      dtx -= Math.round(dtx / worldTiles) * worldTiles;
      markers.push({
        isDestination: true,
        px: dtx * TILE_SIZE,
        py: (lat2tileY(destination.lat, zoom) - tyf) * TILE_SIZE,
        distanceMeters: haversineMeters(lat, lon, destination.lat, destination.lon),
        colorCss: DESTINATION_COLOR,
      });
    }
    const onScreenPeers = [];
    const offScreenPeers = [];
    for (const peer of markers) {
      const { px, py } = peer;
      const pixelDist = Math.hypot(px, py);
      const entry = { ...peer, px, py, pixelDist };
      if (pixelDist <= visibleRadius) onScreenPeers.push(entry);
      else offScreenPeers.push(entry);
    }

    for (const peer of onScreenPeers) {
      if (peer.isDestination) {
        drawPin(peer.px, peer.py, s);
        continue;
      }
      ctx.beginPath();
      ctx.arc(peer.px, peer.py, 4 * s, 0, Math.PI * 2);
      ctx.fillStyle = peer.colorCss;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5 * s;
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore(); // back to unrotated, unclipped canvas space

    // Labels drawn unclipped so they stay legible at the rim.
    ctx.font = `600 ${Math.round(9 * s)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 2.5 * s;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    for (const peer of onScreenPeers) {
      const label = formatPeerDistance(peer.distanceMeters);
      const lx = center + peer.px;
      const ly = center + peer.py + 12 * s;
      ctx.textBaseline = 'top';
      ctx.strokeText(label, lx, ly);
      ctx.fillStyle = '#1a1a1a';
      ctx.fillText(label, lx, ly);
    }
    // Off-screen arrows just outside the dial, on the overlay canvas.
    const actx = arrowsCtx || ctx;
    const arrowRadius = mapRadius + arrowBand * 0.55;
    actx.font = `600 ${Math.round(9 * s)}px system-ui, sans-serif`;
    actx.textAlign = 'center';
    actx.lineWidth = 2.5 * s;
    actx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    for (const peer of offScreenPeers) {
      const angle = Math.atan2(peer.py, peer.px);
      const ex = center + Math.cos(angle) * arrowRadius;
      const ey = center + Math.sin(angle) * arrowRadius;
      actx.save();
      actx.translate(ex, ey);
      actx.rotate(angle + Math.PI / 2);
      actx.beginPath();
      actx.moveTo(0, -10 * s);
      actx.lineTo(7 * s, 8 * s);
      actx.lineTo(0, 4 * s);
      actx.lineTo(-7 * s, 8 * s);
      actx.closePath();
      actx.fillStyle = peer.colorCss;
      actx.strokeStyle = '#ffffff';
      actx.lineWidth = 1.5 * s;
      actx.fill();
      actx.stroke();
      actx.restore();

      const label = formatPeerDistance(peer.distanceMeters);
      actx.textBaseline = 'middle';
      const lx = center + Math.cos(angle) * (mapRadius - 12 * s);
      const ly = center + Math.sin(angle) * (mapRadius - 12 * s);
      actx.strokeText(label, lx, ly);
      actx.fillStyle = '#1a1a1a';
      actx.fillText(label, lx, ly);
    }

    // Static "N", halo-stroked for legibility.
    const edgeR = mapRadius - 10 * s;
    ctx.font = `600 ${Math.round(11 * s)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * s;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.strokeText('N', center, center - edgeR);
    ctx.fillStyle = '#c0392b';
    ctx.fillText('N', center, center - edgeR);

    // Car marker at the centre, rotated to the heading.
    ctx.save();
    ctx.translate(center, center);
    ctx.rotate((headingDeg * Math.PI) / 180);
    ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-6, 8);
    ctx.closePath();
    ctx.fillStyle = '#ff4d4d';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Bezel ring on the dial edge; nothing beyond it.
    ctx.beginPath();
    ctx.arc(center, center, mapRadius - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineWidth = 3 * s;
    ctx.stroke();

    updateScaleBar(metersPerPx);
    tiles.prune();
  }

  /** `viewFrame`: see app/viewFrame.js. */
  function update(chassisMesh, viewFrame, remotePoses = []) {
    if (!chassisMesh || !viewFrame) return;
    const { lat, lon } = viewFrame.toLatLon(chassisMesh.position.x, chassisMesh.position.z);
    const headingDeg = computeHeadingDeg(chassisMesh);
    const carX = chassisMesh.position.x;
    const carZ = chassisMesh.position.z;
    const peers = remotePoses.map((pose) => {
      const dx = pose.x - carX;
      const dz = pose.z - carZ;
      return {
        dx,
        dz,
        distanceMeters: Math.hypot(dx, dz),
        colorCss: colorToCss(pose.color),
      };
    });
    draw(lat, lon, headingDeg, peers);
    updateRouteReadout();
    if (coordsEl) coordsEl.textContent = formatCoords(lat, lon);
    maybeUpdatePlaceName(lat, lon);
  }

  function updateRouteReadout() {
    if (!routeEl) return;
    const state = getRouteState?.();
    const status = state?.status ?? 'idle';
    routeEl.hidden = status === 'idle';
    if (status === 'idle') return;
    let arrow = '';
    let turn = '';
    let turnDist = '';
    let summary = '';
    if (status === 'loading') {
      turn = 'Finding route\u2026';
    } else if (status === 'error') {
      turn = `No route: ${state.error}`;
    } else if (state.progress?.arrived) {
      arrow = '\u2691';
      turn = 'You have arrived';
    } else if (state.progress) {
      const { next, remainingM, remainingS } = state.progress;
      if (next) {
        arrow = next.arrow;
        turn = next.text;
        turnDist = formatRouteDistance(next.distanceM);
      }
      summary = `${formatRouteDistance(remainingM)} \u00b7 ${formatRouteDuration(remainingS)}`;
    }
    routeEl.classList.toggle('is-error', status === 'error');
    setText(routeArrowEl, arrow);
    setText(routeTurnEl, turn);
    setText(routeTurnDistEl, turnDist);
    setText(routeSummaryEl, summary);
  }

  /** Navigation-panel selection shown as a pin; null hides it. */
  function setDestination(latLon) {
    destination = latLon ? { lat: latLon.lat, lon: latLon.lon } : null;
  }

  function setScenarioPoints(points) {
    scenarioPoints = points ?? [];
  }

  /** Editor stage route and its reverse run's ({ mx, my } normalised Web Mercator); null hides one. */
  function setStageRoute(route, reverse = null) {
    stageRoute = route;
    reverseRoute = reverse;
  }

  return { update, setDestination, setScenarioPoints, setStageRoute };
}
