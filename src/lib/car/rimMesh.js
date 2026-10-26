// Low-poly procedural rim (styles in ./rims.js): barrel, a cone from the outer lip down to the
// face, and the face as rings around the axis with the windows between spokes / holes left open.
// Faces +x on a left wheel, -x on a right one.

import * as THREE from 'three';

// Face radii, share of the rim radius: face edge, and the open band per style.
const FACE_EDGE = 0.86;
const BANDS = { holes: [0.42, 0.68], spokes: [0.2, 0.8] };
const SOLID_RINGS = [0.3, 0.6];
// Window side walls, share of the rim width, so spokes don't read paper thin.
const WALL_DEPTH = 0.15;
// Dark disc behind the windows (hub / brake), share of the rim width in from the inner edge.
const BACK_INSET = 0.2;
const BACK_COLOR = 0x202022;
const MIN_FACE_Z = -0.4; // deepest face edge, share of the rim width from the centre plane

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
 * Rim group for a wheel of rim `radius` / `width` (m), `segments` around like the tyre.
 * @param {object} style - a RIMS entry
 */
export function buildRim(style, color, radius, width, segments, side = 1) {
  const { angles, open } = faceAngles(style, segments);
  const lipR = radius * Math.cos(Math.PI / segments) * 0.98; // inside the tyre's polygon
  const edgeR = radius * FACE_EDGE;
  const edgeZ = Math.max(width * MIN_FACE_Z, width / 2 - (style.depth ?? 0.2) * width);
  const sign = style.face === 'convex' ? 1 : style.face === 'concave' ? -1 : 0;
  const dish = sign * (style.dish ?? 0.15) * width;
  const band = BANDS[style.style];
  const twist = style.style === 'spokes' ? (style.twist ?? 0) : 0;

  const zAt = (r) => edgeZ + dish * (1 - (r / edgeR) ** 2);
  const twistAt = (r) => (band ? twist * THREE.MathUtils.clamp((r - band[0]) / (band[1] - band[0]), 0, 1) : 0);
  const point = (r, a, z = zAt(r)) => {
    const t = a + twistAt(r);
    return [Math.cos(t) * r, Math.sin(t) * r, z];
  };

  const pos = [];
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  const quad = (a, b, c, d) => {
    tri(a, b, c);
    tri(a, c, d);
  };
  const count = angles.length;
  const each = (fn) => {
    for (let i = 0; i < count; i++) fn(angles[i], angles[(i + 1) % count] + (i + 1 === count ? Math.PI * 2 : 0), open[i]);
  };

  // Lip -> face edge cone.
  each((a0, a1) => quad(point(lipR, a0, width / 2), point(lipR, a1, width / 2), point(edgeR, a1), point(edgeR, a0)));

  // Face rings, centre to edge; the band (holes / spokes) skips its windows.
  const rings = (band ?? SOLID_RINGS).map((f) => f * radius);
  const radii = [0, ...rings, edgeR];
  for (let r = 0; r < radii.length - 1; r++) {
    const inner = radii[r];
    const outer = radii[r + 1];
    const isBand = band && inner === rings[0] && outer === rings[1];
    each((a0, a1, isOpen) => {
      if (isBand && isOpen) return;
      if (inner === 0) tri([0, 0, zAt(0)], point(outer, a0), point(outer, a1));
      else quad(point(inner, a0), point(outer, a0), point(outer, a1), point(inner, a1));
    });
  }

  // Window walls: back from the face along the window's four sides.
  if (band) {
    const depth = WALL_DEPTH * width;
    const back = (p) => [p[0], p[1], p[2] - depth];
    const [rIn, rOut] = rings;
    const wall = (p, q) => quad(p, q, back(q), back(p));
    each((a0, a1, isOpen) => {
      if (!isOpen) return;
      wall(point(rIn, a0), point(rIn, a1));
      wall(point(rOut, a0), point(rOut, a1));
    });
    each((a0, a1, isOpen) => {
      if (!isOpen) return;
      // Both side edges, with the band's middle radius so twisted spokes bend.
      for (const a of [a0, a1]) {
        const mid = (rIn + rOut) / 2;
        wall(point(rIn, a), point(mid, a));
        wall(point(mid, a), point(rOut, a));
      }
    });
  }

  const faceGeo = new THREE.BufferGeometry();
  faceGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  faceGeo.computeVertexNormals();
  const barrelGeo = new THREE.CylinderGeometry(lipR, lipR, width, segments, 1, true);
  barrelGeo.rotateX(Math.PI / 2);

  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.8, roughness: 0.35, flatShading: true, side: THREE.DoubleSide });
  const group = new THREE.Group();
  for (const geo of [faceGeo, barrelGeo]) {
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
