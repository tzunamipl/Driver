// Low-poly procedural rim (styles in ./rims.js): an outer belt (barrel) the full wheel width, a
// plain zero-thickness body from the belt in to the hub, with the windows between spokes / holes
// left open, and a central hub sitting on the body. Faces +x on a left wheel, -x on a right one.

import * as THREE from 'three';

// Open band per style, share of the rim radius; spokes run from the hub out to the outer value.
const BANDS = { holes: [0.42, 0.68], spokes: [0, 0.8] };
const MIN_BAND = 0.06; // narrowest band left open past the hub, share of the rim radius
const DEFAULT_HUB = 0.3; // hub diameter, share of the rim diameter
const HUB_DEPTH = 0.12; // how far the hub stands off the body, share of the rim width
// Body z limits, share of the rim width from the centre plane: stays in front of the back disc.
const MIN_BODY_Z = -0.42;
const MAX_BODY_Z = 0.5;
// Dark disc behind the windows (hub / brake), just inside the belt's inner edge.
const BACK_INSET = 0.02;
const BACK_COLOR = 0x202022;
const PROFILE_SEGMENTS = 3;

/** Sorted angles (rad) around the face with `open[i]` = interval i..i+1 is a window. */
function faceAngles(style, segments) {
  const n = style.style === 'solid' ? 1 : Math.max(1, Math.round(style.count ?? 5));
  const share = style.style === 'holes' ? (style.holeSize ?? 0.35) : style.style === 'spokes' ? 1 - (style.spokeWidth ?? 0.35) : 0;
  const k = Math.max(1, Math.ceil(segments / n));
  const lo = 0.5 - share / 2;
  const hi = 0.5 + share / 2;
  const units = []; // in sector units
  for (let s = 0; s < n; s++) {
    for (let j = 0; j < k; j++) if (!share || j / k <= lo || j / k >= hi) units.push(s + j / k);
    if (share) units.push(s + lo, s + hi);
  }
  units.sort((a, b) => a - b);
  for (let i = units.length - 1; i > 0; i--) if (units[i] - units[i - 1] < 1e-6) units.splice(i, 1);
  const angles = units.map((u) => (u / n) * Math.PI * 2);
  const open = units.map((u, i) => {
    const next = units[(i + 1) % units.length] + (i + 1 === units.length ? n : 0);
    const mid = ((u + next) / 2) % 1;
    return share > 0 && mid > lo && mid < hi;
  });
  return { angles, open };
}

/**
 * Rim group for a wheel of rim `radius` / belt `width` (m), `segments` around like the tyre.
 * @param {object} style - a RIMS entry
 */
export function buildRim(style, color, radius, width, segments, side = 1) {
  const { angles, open } = faceAngles(style, segments);
  const lipR = radius * Math.cos(Math.PI / segments) * 0.98; // inside the tyre's polygon
  const hubR = THREE.MathUtils.clamp(style.hub ?? DEFAULT_HUB, 0.05, 0.9) * radius;
  const edgeZ = THREE.MathUtils.clamp(width / 2 - (style.depth ?? 0.2) * width, MIN_BODY_Z * width, MAX_BODY_Z * width);
  const sign = style.face === 'convex' ? 1 : style.face === 'concave' ? -1 : 0;
  const dish = sign * (style.dish ?? 0.15) * width;

  // Body profile: hub edge -> belt in PROFILE_SEGMENTS straight pieces of 1 - t^2 (a dome / bowl).
  const profile = [];
  for (let i = 0; i <= PROFILE_SEGMENTS; i++) {
    const t = i / PROFILE_SEGMENTS;
    const z = THREE.MathUtils.clamp(edgeZ + dish * (1 - t * t), MIN_BODY_Z * width, MAX_BODY_Z * width);
    profile.push({ r: hubR + (lipR - hubR) * t, z });
  }
  const zAt = (r) => {
    for (let i = 1; i < profile.length; i++) {
      const a = profile[i - 1];
      const b = profile[i];
      if (r <= b.r || i === profile.length - 1) return a.z + (b.z - a.z) * THREE.MathUtils.clamp((r - a.r) / (b.r - a.r), 0, 1);
    }
    return edgeZ;
  };

  let band = BANDS[style.style];
  if (band) {
    band = [Math.max(band[0] * radius, hubR + (style.style === 'holes' ? MIN_BAND * radius : 0)), Math.min(band[1] * radius, lipR)];
    if (band[1] - band[0] < MIN_BAND * radius) band = null;
  }
  const twist = band && style.style === 'spokes' ? (style.twist ?? 0) : 0;
  const twistAt = (r) => (twist ? twist * THREE.MathUtils.clamp((r - band[0]) / (band[1] - band[0]), 0, 1) : 0);
  const point = (r, a) => {
    const t = a + twistAt(r);
    return [Math.cos(t) * r, Math.sin(t) * r, zAt(r)];
  };

  const pos = [];
  const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  const count = angles.length;
  const each = (fn) => {
    for (let i = 0; i < count; i++) fn(angles[i], angles[(i + 1) % count] + (i + 1 === count ? Math.PI * 2 : 0), open[i]);
  };

  // Body rings, hub to belt, on the profile's corners plus the band's edges; the band skips its windows.
  const radii = [...profile.map((p) => p.r), ...(band ?? [])].sort((a, b) => a - b).filter((r, i, all) => i === 0 || r - all[i - 1] > 1e-6);
  for (let i = 0; i < radii.length - 1; i++) {
    const inner = radii[i];
    const outer = radii[i + 1];
    const inBand = band && inner >= band[0] - 1e-6 && outer <= band[1] + 1e-6;
    each((a0, a1, isOpen) => {
      if (!(inBand && isOpen)) quad(point(inner, a0), point(outer, a0), point(outer, a1), point(inner, a1));
    });
  }

  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  bodyGeo.computeVertexNormals();
  const beltGeo = new THREE.CylinderGeometry(lipR, lipR, width, segments, 1, true);
  beltGeo.rotateX(Math.PI / 2);
  const hubDepth = HUB_DEPTH * width;
  const hubGeo = new THREE.CylinderGeometry(hubR, hubR, hubDepth, segments);
  hubGeo.rotateX(Math.PI / 2);
  hubGeo.translate(0, 0, profile[0].z + hubDepth / 2);

  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.8, roughness: 0.35, flatShading: true, side: THREE.DoubleSide });
  const group = new THREE.Group();
  for (const geo of [bodyGeo, beltGeo, hubGeo]) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    group.add(mesh);
  }
  if (band) {
    const backGeo = new THREE.CircleGeometry(lipR, segments);
    backGeo.translate(0, 0, -width / 2 + BACK_INSET * width);
    group.add(new THREE.Mesh(backGeo, new THREE.MeshStandardMaterial({ color: BACK_COLOR, roughness: 0.8, flatShading: true })));
  }
  // Face axis z -> wheel axle x, outboard by `side` (+1 left, -1 right).
  group.rotation.y = (side * Math.PI) / 2;
  return group;
}

/** Frees a rim group's geometry and materials. */
export function disposeRim(group) {
  group.traverse((obj) => {
    obj.geometry?.dispose();
    obj.material?.dispose();
  });
}
