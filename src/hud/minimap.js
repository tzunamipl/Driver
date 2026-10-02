import { lon2tileX, lat2tileY, localToLatLon, tileSizeMeters } from '../lib/geo.js';
import { computeHeadingDeg } from '../lib/heading.js';
import { MINIMAP_MIN_ZOOM, MINIMAP_MAX_ZOOM, MINIMAP_DEFAULT_ZOOM, MINIMAP_STORAGE_KEY } from '../config.js';

// Car-navigation-style minimap, bottom-left of the screen. Deliberately
// *not* the aerial/satellite imagery the 3D terrain uses - a real car GPS
// shows a drawn street map (road lines, street names, town/city labels),
// which is what's actually legible at minimap scale/size. Tiles come from
// the official OpenStreetMap "Standard" raster tile layer
// (tile.openstreetmap.org) - free, no API key/account needed, unlike
// basemap providers such as CARTO/Mapbox/Stadia which now gate their
// raster tiles behind a required (if free-tier) API key. See the
// OpenStreetMap attribution in the #attribution overlay, required by OSM's
// tile usage policy: https://operations.osmfoundation.org/policies/tiles/
//
// "North-up": the map itself never rotates - true north is always straight
// up (with a static "N" marker at the top) - and a car-shaped marker
// rotates in place at the center to show the current heading instead, the
// same convention as most in-dash car nav systems' "north up" mode.
//
// Zoom is adjustable (mouse wheel over the widget, or the +/- buttons) and
// persisted across reloads; a scale bar (recomputed whenever zoom or
// latitude changes enough to matter) shows the real-world distance one
// on-screen segment represents, so the widget is both zoomable and
// distance-scalable rather than a fixed-scale decoration.
//
// The current coordinates and the town/city name are shown above the
// widget. Coordinates are free (computed locally from the car's position,
// no network call); the place name is looked up via the free, keyless
// OpenStreetMap Nominatim reverse-geocoding API - throttled hard (only
// re-queried after moving a meaningful distance, and never more than once
// every REGEOCODE_MIN_INTERVAL_MS) to stay well inside Nominatim's usage
// policy (nominatim.org/release-docs/latest/api/Reverse/), which is far
// stricter about request rate than the tile servers.

const TILE_SIZE = 256;
// OSM's tile usage policy permits spreading load across these legacy
// subdomains; a minimap only ever has a couple dozen tiles in view at once
// (well under the policy's "no bulk downloading" / reasonable-rate
// guidance), so this stays comfortably within normal browser use.
const MAP_SUBDOMAINS = ['a', 'b', 'c'];
const mapTileUrl = (z, x, y) =>
  `https://${MAP_SUBDOMAINS[(x + y) % MAP_SUBDOMAINS.length]}.tile.openstreetmap.org/${z}/${x}/${y}.png`;

function loadTileImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // OpenStreetMap's tile responses include Access-Control-Allow-Origin: *,
    // so this succeeds (untainted canvas) rather than needing to be dropped
    // for a same-origin-only load.
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

// Reverse-geocoding (place name) throttling. Nominatim's usage policy
// caps *all* clients well under "once a second" territory for a hobby
// project's continuous polling - only re-look-up the place name after the
// car has actually moved a meaningful distance, and never more than once
// per interval regardless of movement.
const REGEOCODE_MIN_INTERVAL_MS = 15_000;
const REGEOCODE_MIN_DISTANCE_M = 400;
// Address fields to try, in order of preference (most to least specific
// "town-scale" name) - Nominatim's `address` object uses different keys
// depending on how the place is tagged/how big it is.
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

// Distance labels for other players' markers: plain km up to 999km, then
// "kkkm" (thousands of km) beyond that - teleporting via the address
// search (see ui/addressSearch.js) means another active player can
// legitimately be a continent away, so the label needs a unit that stays
// readable at both city-block and intercontinental scale.
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
  // Off-screen peer arrows are drawn on this separate, transparent,
  // pointer-events:none overlay canvas - stacked on top of the zoom
  // buttons/scale bar in the DOM (see index.html) purely so an arrow is
  // never visually hidden behind that chrome, without the overlay ever
  // stealing clicks/wheel input meant for the buttons or the map below.
  const arrowsCtx = arrowsCanvas?.getContext('2d') ?? null;
  const tileCache = new Map(); // "z/x/y" -> { img, ready }
  let zoom = loadStoredZoom();
  // `dialSizeCss` is the puck's own diameter - the #minimap box's CSS
  // width, unchanged from the original design. `sizeCss` is the actual
  // (bigger) canvas diameter, padded by `arrowBand` on every side so
  // off-screen peer arrows have transparent room to be drawn past the
  // dial's edge without the canvas's own background/clip reaching that
  // far (see resize()/draw() below).
  let dialSizeCss = 0;
  let sizeCss = 0;
  let arrowBand = 0;
  let dpr = 1;

  // Reverse-geocoding state: last place we successfully looked up (so we
  // can tell how far the car has since moved), and a guard against firing
  // a second request while one is still in flight.
  let lastGeocodeLat = null;
  let lastGeocodeLon = null;
  let lastGeocodeAt = 0;
  let geocodeInFlight = false;

  function maybeUpdatePlaceName(lat, lon) {
    if (!placeEl || geocodeInFlight) return;
    const now = performance.now();
    if (now - lastGeocodeAt < REGEOCODE_MIN_INTERVAL_MS) return;
    if (lastGeocodeLat != null) {
      // Cheap flat-earth distance estimate - plenty accurate at this scale,
      // and we only need it to decide "moved enough to bother re-querying".
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
        // Offline / rate-limited / blocked - just keep showing the last
        // known name rather than clearing it.
      })
      .finally(() => {
        geocodeInFlight = false;
      });
  }

  function resize() {
    const rect = root.getBoundingClientRect();
    dialSizeCss = rect.width || root.clientWidth;
    // Scale factor the decorations (marker, "N", rings, arrows) were
    // originally tuned at 190px for - see draw() below.
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
    // Longitude tiles wrap around the antimeridian; latitude tiles don't
    // (there's no tile above the north/south pole row), so only wrap x.
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

  // Bound the tile cache so hours of driving (thousands of distinct tiles
  // at various zooms) don't grow it forever.
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
    // Original design was tuned at 190px; scale the decorations (marker,
    // "N" label, rings) proportionally so the widget still looks right if
    // its CSS size changes.
    const s = dialSizeCss / 190;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    if (arrowsCtx) {
      arrowsCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      arrowsCtx.clearRect(0, 0, size, size);
    }

    // The street-map "dial" itself is exactly the original (unshrunk,
    // ungrown) puck size - `arrowBand` is just transparent canvas overflow
    // around it, with no background/border/shadow of its own. Off-screen
    // peer arrows are drawn out there (see below), so they visibly sit
    // outside the dial's boundary rather than inside a permanently
    // reserved ring.
    const mapRadius = center - arrowBand;

    // Drop shadow + fill for the dial circle itself, drawn *before* the
    // circular clip below (so the shadow isn't clipped away) - reproduces
    // what used to be a plain CSS box-shadow on the canvas element, back
    // when the canvas was exactly the dial's own size.
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
    // The circle's radius is the farthest any visible pixel can be from the
    // center regardless of rotation, so a square "cover the corners" margin
    // isn't needed - the clip already discards anything past that radius.
    const radiusTiles = Math.ceil(mapRadius / TILE_SIZE) + 1;

    // North-up: no rotation here (unlike track-up mode) - true north is
    // always straight up, and it's the car marker (drawn below, outside
    // the clip) that rotates to show heading instead.
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
    // Other active players: local (x, z) meters, same flat frame the
    // physics/rendering already use (see remoteCollisions.js), converted
    // straight to on-screen pixels rather than round-tripped through
    // lat/lon - matches every other place this game treats "local meters"
    // as the ground truth, and stays numerically sane even when a
    // teleported player is thousands of km away (see formatDistance).
    // North-up map: +x (east) is screen-right, +z (south) is screen-down,
    // so no axis flip is needed.
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

    // Distance labels for on-map peers - drawn unclipped so they stay
    // fully legible near the rim instead of being cut off by the round
    // bezel. Off-screen peers' arrows/labels are handled separately below
    // on the overlay canvas (see actx).
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
    // Arrows sit just outside the dial's edge, in the otherwise-empty
    // transparent overflow area - clearly outside the map boundary rather
    // than overlapping it or sitting inside a permanent decorated ring.
    // Drawn on the separate overlay canvas (see arrowsCtx above) so they
    // always render on top of the zoom buttons/scale bar rather than
    // being hidden behind that chrome.
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

    // Static north indicator - the map never rotates, so "N" always sits
    // at the top of the dial. Halo-stroked so it stays legible over both
    // light and dark patches of the basemap.
    const edgeR = mapRadius - 10 * s;
    ctx.font = `600 ${Math.round(11 * s)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * s;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.strokeText('N', center, center - edgeR);
    ctx.fillStyle = '#c0392b';
    ctx.fillText('N', center, center - edgeR);

    // Car marker: fixed at the center, rotated to the current heading (map
    // stays north-up, so this is what actually shows which way the car is
    // facing).
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

    // Bezel ring on the dial's own edge - replaces the plain CSS
    // box-shadow the canvas used to have back when it was exactly the
    // dial's size. Nothing is drawn beyond this (no outer ring at the
    // bigger canvas edge), so the arrow-overflow area stays fully
    // transparent when no peers are off-screen.
    ctx.beginPath();
    ctx.arc(center, center, mapRadius - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineWidth = 3 * s;
    ctx.stroke();

    updateScaleBar(metersPerPx);
    pruneCache();
  }

  function update(chassisMesh, origin, remotePoses = []) {
    if (!chassisMesh || !origin) return;
    const { lat, lon } = localToLatLon(chassisMesh.position.x, chassisMesh.position.z, origin.lat, origin.lon);
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
