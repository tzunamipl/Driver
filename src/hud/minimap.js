import { lon2tileX, lat2tileY, tileSizeMeters } from '../lib/geo.js';
import { computeHeadingDeg } from '../lib/heading.js';
import { MINIMAP_MIN_ZOOM, MINIMAP_MAX_ZOOM, MINIMAP_DEFAULT_ZOOM, MINIMAP_STORAGE_KEY } from '../config.js';

// Round, north-up street-map minimap (OSM Standard raster tiles: keyless;
// attribution required by OSM policy). The car marker rotates; the map
// doesn't. Zoom via wheel/buttons (persisted) with a scale bar. Shows
// coordinates and a place name from Nominatim reverse geocoding, heavily
// throttled per its usage policy.

const TILE_SIZE = 256;
// Legacy subdomains are allowed by OSM's tile policy.
const MAP_SUBDOMAINS = ['a', 'b', 'c'];
const mapTileUrl = (z, x, y) =>
  `https://${MAP_SUBDOMAINS[(x + y) % MAP_SUBDOMAINS.length]}.tile.openstreetmap.org/${z}/${x}/${y}.png`;

function loadTileImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // OSM tiles send CORS headers, so the canvas stays untainted.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

function clampZoom(z) {
  return Math.min(MINIMAP_MAX_ZOOM, Math.max(MINIMAP_MIN_ZOOM, z));
}

function loadStoredZoom() {
  const raw = Number(localStorage.getItem(MINIMAP_STORAGE_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampZoom(raw) : MINIMAP_DEFAULT_ZOOM;
}

// "Nice" round distances (meters) considered for the scale bar.
const SCALE_STEPS_M = [
  5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10_000, 20_000, 25_000, 50_000, 100_000, 200_000,
];

// Place-name lookups: only after moving this far, and at most this often.
const REGEOCODE_MIN_INTERVAL_MS = 15_000;
const REGEOCODE_MIN_DISTANCE_M = 400;
// Nominatim address keys, most to least specific.
const PLACE_NAME_FIELDS = ['city', 'town', 'village', 'municipality', 'county', 'state'];

function formatCoords(lat, lon) {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}\u00b0${latDir} ${Math.abs(lon).toFixed(5)}\u00b0${lonDir}`;
}

// Peer colors arrive as 0xRRGGBB integers (see net.js's sanitizeColor).
function colorToCss(color) {
  const n = Number.isInteger(color) ? color & 0xffffff : 0xffffff;
  return `#${n.toString(16).padStart(6, '0')}`;
}

// Peer distance labels: km, then "kkkm" (teleported peers may be continents away).
function formatDistance(meters) {
  const km = meters / 1000;
  if (km >= 1000) {
    const kkm = km / 1000;
    return `${kkm.toFixed(kkm >= 10 ? 0 : 1)} kkkm`;
  }
  if (km >= 10) return `${Math.round(km)} km`;
  return `${km.toFixed(1)} km`;
}

export function createMinimapHud() {
  const root = document.getElementById('minimap');
  const canvas = document.getElementById('minimap-canvas');
  const arrowsCanvas = document.getElementById('minimap-arrows-canvas');
  const zoomInBtn = document.getElementById('minimap-zoom-in');
  const zoomOutBtn = document.getElementById('minimap-zoom-out');
  const scaleBarEl = document.getElementById('minimap-scale-bar');
  const scaleLabelEl = document.getElementById('minimap-scale-label');
  const placeEl = document.getElementById('minimap-place');
  const coordsEl = document.getElementById('minimap-coords');
  if (!root || !canvas) return { update() {} };

  const ctx = canvas.getContext('2d');
  // Off-screen peer arrows go on a click-through overlay canvas above the
  // zoom/scale chrome.
  const arrowsCtx = arrowsCanvas?.getContext('2d') ?? null;
  const tileCache = new Map(); // "z/x/y" -> { img, ready }
  let zoom = loadStoredZoom();
  // dialSizeCss = the #minimap box width; the canvas is larger by
  // arrowBand on each side so arrows can be drawn outside the dial.
  let dialSizeCss = 0;
  let sizeCss = 0;
  let arrowBand = 0;
  let dpr = 1;

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
    localStorage.setItem(MINIMAP_STORAGE_KEY, String(zoom));
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

  function getTile(z, x, y) {
    const n = 2 ** z;
    // Wrap x across the antimeridian (y doesn't wrap).
    const wrappedX = ((x % n) + n) % n;
    if (y < 0 || y >= n) return null;
    const key = `${z}/${wrappedX}/${y}`;
    let entry = tileCache.get(key);
    if (!entry) {
      entry = { img: null, ready: false, failed: false };
      tileCache.set(key, entry);
      loadTileImage(mapTileUrl(z, wrappedX, y))
        .then((img) => {
          entry.img = img;
          entry.ready = true;
        })
        .catch(() => {
          entry.failed = true;
        });
    }
    return entry;
  }

  // Bounded tile cache.
  function pruneCache() {
    if (tileCache.size <= 600) return;
    let toDrop = tileCache.size - 400;
    for (const key of tileCache.keys()) {
      if (toDrop-- <= 0) break;
      tileCache.delete(key);
    }
  }

  function updateScaleBar(metersPerPx) {
    if (!scaleBarEl || !scaleLabelEl) return;
    const targetPx = 56;
    let chosen = SCALE_STEPS_M[0];
    for (const step of SCALE_STEPS_M) {
      if (step / metersPerPx <= targetPx) chosen = step;
      else break;
    }
    const barPx = Math.max(4, chosen / metersPerPx);
    scaleBarEl.style.width = `${barPx}px`;
    scaleLabelEl.textContent = chosen >= 1000 ? `${chosen / 1000} km` : `${chosen} m`;
  }

  function draw(lat, lon, headingDeg, peers) {
    resize();
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
        const entry = getTile(zoom, tileX, tileY);
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

    const metersPerPx = tileSizeMeters(zoom, lat) / TILE_SIZE;
    // Peers: local (x, z) metres straight to pixels (+x right, +z down).
    const edgeMargin = 16 * s;
    const visibleRadius = mapRadius - edgeMargin;
    const onScreenPeers = [];
    const offScreenPeers = [];
    for (const peer of peers) {
      const px = peer.dx / metersPerPx;
      const py = peer.dz / metersPerPx;
      const pixelDist = Math.hypot(px, py);
      const entry = { ...peer, px, py, pixelDist };
      if (pixelDist <= visibleRadius) onScreenPeers.push(entry);
      else offScreenPeers.push(entry);
    }

    for (const peer of onScreenPeers) {
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
      const label = formatDistance(peer.distanceMeters);
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

      const label = formatDistance(peer.distanceMeters);
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
    pruneCache();
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
    if (coordsEl) coordsEl.textContent = formatCoords(lat, lon);
    maybeUpdatePlaceName(lat, lon);
  }

  return { update };
}
