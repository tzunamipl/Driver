import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { DEFAULT_BODY_COLOR } from '../../../config.js';

// Low-poly Attacker RS in Group A rally trim: wedge nose with
// sloped headlights, big-mouth bumper, offset plate, louvred bonnet, flared
// arches, roof scoop, two-tier wing, mudflaps. Modelled in metres for a
// 1.8 x 4 m chassis (wheels at z = ±1.3) and scaled to the requested size.

const REF_WIDTH = 1.8;
const REF_LENGTH = 4;

const ARCH_Z = 1.3;
const ARCH_Y = -0.34;
const ARCH_R = 0.38;
const FLARE = 0.035;
const FLARE_SPAN = 0.6;
const SILL_Y = -0.26;

// Piecewise-linear profiles as [z, value], z descending (nose → tail).
const BODY_TOP = [
    [2.22, -0.03], [2.1, 0.09], [1.95, 0.13], [0.88, 0.27], [-0.95, 0.31],
    [-1.58, 0.32], [-2.0, 0.345], [-2.1, 0.33], [-2.19, 0.2],
];
const BODY_BOTTOM = [[2.22, -0.25], [2.16, -0.33], [2.0, -0.34], [-2.0, -0.34], [-2.12, -0.31], [-2.19, -0.22]];
const BODY_HALF_WIDTH = [[2.22, 0.72], [2.12, 0.83], [1.95, 0.875], [-1.95, 0.875], [-2.12, 0.84], [-2.19, 0.79]];

// Greenhouse stations: belt, side-glass top, roof edge, crown, half widths.
// Degenerate first/last stations close the windshield and rear window.
const CABIN = [
    { z: 0.88, ys: 0, ye: 0.003, yc: 0.003, wb: 0.76, wt: 0.76 },
    { z: 0.02, ys: 0.69, ye: 0.735, yc: 0.755, wb: 0.765, wt: 0.645 },
    { z: -0.4, ys: 0.69, ye: 0.733, yc: 0.753, wb: 0.765, wt: 0.643 },
    { z: -0.5, ys: 0.688, ye: 0.732, yc: 0.752, wb: 0.765, wt: 0.643 },
    { z: -0.95, ys: 0.68, ye: 0.725, yc: 0.745, wb: 0.765, wt: 0.64 },
    { z: -1.58, ys: 0, ye: 0.003, yc: 0.003, wb: 0.74, wt: 0.74 },
];
const WINDSHIELD = 0;
const B_PILLAR = 2;
const REAR_WINDOW = CABIN.length - 2;

const BODY = 0;
const GLASS = 1;
const TRIM = 2;

const profile = (table) => (z) => {
    if (z >= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
        const [z1, v1] = table[i];
        if (z >= z1) {
            const [z0, v0] = table[i - 1];
            return v1 + (v0 - v1) * (z - z1) / (z0 - z1);
        }
    }
    return table[table.length - 1][1];
};
const top = profile(BODY_TOP);
const bottom = profile(BODY_BOTTOM);
const halfWidth = profile(BODY_HALF_WIDTH);

/** Fender bulge peaking over each axle. */
const flare = (z) => {
    const t = (Math.abs(z) - ARCH_Z) / FLARE_SPAN;
    return Math.abs(t) < 1 ? FLARE * (1 - t * t) : 0;
};

/**
 * Lofts rings (same point count, clockwise seen from +z, z descending) into
 * a flat-shaded shell; materialOf(segment, column) picks a material index.
 */
function loft(rings, materialOf, caps) {
    const groups = [[], [], []];
    const tri = (m, a, b, c) => groups[m].push(...a, ...b, ...c);
    const n = rings[0].length;
    for (let i = 0; i < rings.length - 1; i++) {
        for (let j = 0; j < n; j++) {
            const k = (j + 1) % n;
            const m = materialOf(i, j);
            tri(m, rings[i][j], rings[i][k], rings[i + 1][k]);
            tri(m, rings[i][j], rings[i + 1][k], rings[i + 1][j]);
        }
    }
    if (caps) {
        const cap = (ring, front) => {
            const c = [0, 1, 2].map((a) => ring.reduce((s, p) => s + p[a], 0) / n);
            for (let j = 0; j < n; j++) {
                const k = (j + 1) % n;
                if (front) tri(BODY, c, ring[k], ring[j]);
                else tri(BODY, c, ring[j], ring[k]);
            }
        };
        cap(rings[0], true);
        cap(rings[rings.length - 1], false);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(groups.flat(), 3));
    let start = 0;
    groups.forEach((g, m) => {
        geometry.addGroup(start, g.length / 3, m);
        start += g.length / 3;
    });
    geometry.computeVertexNormals();
    return geometry;
}

function lowerBodyGeometry() {
    const arch = (cz) => Array.from({ length: 7 }, (_, k) => {
        const t = (k / 6) * Math.PI;
        return { z: cz + ARCH_R * Math.cos(t), yb: ARCH_Y + ARCH_R * Math.sin(t) };
    });
    const inArch = (z) => Math.abs(Math.abs(z) - ARCH_Z) <= ARCH_R;
    const tableZ = [...BODY_TOP, ...BODY_BOTTOM, ...BODY_HALF_WIDTH].map(([z]) => z);
    const stations = [
        ...[...new Set(tableZ)].filter((z) => !inArch(z)).map((z) => ({ z })),
        ...arch(ARCH_Z),
        ...arch(-ARCH_Z),
    ].sort((a, b) => b.z - a.z);

    const rings = stations.map(({ z, yb = bottom(z) }) => {
        const yt = top(z);
        const w = halfWidth(z);
        const f = flare(z);
        const ys = Math.max(yb + 0.005, SILL_Y);
        const yc = Math.max(ys + 0.005, yt - 0.1);
        const ysh = Math.max(yc + 0.005, yt - 0.03);
        const right = [[w - 0.05 + f / 2, yb], [w + f, ys], [w + f, yc], [w - 0.03, ysh], [w - 0.1, Math.max(ysh + 0.005, yt)]];
        const left = right.map(([x, y]) => [-x, y]);
        return [...left, ...right.reverse()].map(([x, y]) => [x, y, z]);
    });
    // Last column is the underside / wheel-well ceiling.
    return loft(rings, (i, j) => (j === 9 ? TRIM : BODY), true);
}

function cabinGeometry() {
    const rings = CABIN.map(({ z, ys, ye, yc, wb, wt }) => {
        const yb = top(z);
        const degenerate = ys === 0;
        const at = (y) => (degenerate ? yb + y : y);
        const right = [[wb, yb], [wt, at(ys)], [wt - 0.07, at(ye)], [0.3, at(yc)]];
        const left = right.map(([x, y]) => [-x, y]);
        return [...left, ...right.reverse()].map(([x, y]) => [x, y, z]);
    });
    // Columns: 0/6 side glass, 1/5 roof rails (A/C pillars), 2-4 roof, 7 hidden base.
    return loft(rings, (i, j) => {
        if (j === 7) return TRIM;
        if (j === 1 || j === 5) return BODY;
        if (j >= 2 && j <= 4) return i === WINDSHIELD || i === REAR_WINDOW ? GLASS : BODY;
        if (i === B_PILLAR) return TRIM;
        return i === REAR_WINDOW ? BODY : GLASS;
    }, false);
}

/** Prism behind a quad (corners counter-clockwise seen from outside), `depth` deep. */
function slabGeometry(corners, depth) {
    const [a, b, , d] = corners.map((p) => new THREE.Vector3(...p));
    const normal = b.clone().sub(a).cross(d.clone().sub(a)).normalize();
    const back = corners.map((p) => new THREE.Vector3(...p).addScaledVector(normal, -depth).toArray());
    const positions = [];
    const quad = (p, q, r, s) => positions.push(...p, ...q, ...r, ...p, ...r, ...s);
    quad(...corners);
    quad(back[3], back[2], back[1], back[0]);
    for (let i = 0; i < 4; i++) {
        const k = (i + 1) % 4;
        quad(corners[i], back[i], back[k], corners[k]);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    return geometry;
}

const mirrorX = (corners) => corners.map(([x, y, z]) => [-x, y, z]).reverse();

/** Road-going Attacker: no roof scoop or mudflaps, a single low wing. */
export function buildRoadBody(chassisWidth, chassisLength, color) {
    return buildBody(chassisWidth, chassisLength, color, { road: true });
}

export function buildBody(chassisWidth, chassisLength, color = DEFAULT_BODY_COLOR, { road = false } = {}) {
    const group = new THREE.Group();
    const body = new THREE.Group();
    body.scale.set(chassisWidth / REF_WIDTH, 1, chassisLength / REF_LENGTH);
    group.add(body);

    const bodyMat = createPaintMaterial(color, { metalness: 0.35, roughness: 0.45, flatShading: true });
    const glassMat = createGlossyMaterial({ color: 0x141c24, metalness: 0.5, roughness: 0.12, flatShading: true });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.8 });
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });
    const lightMat = createGlossyMaterial({ color: 0xf4f6ff, emissive: 0x3a3a40, roughness: 0.15, userData: { lamp: 'head' } });
    const tailMat = createGlossyMaterial({ color: 0xe0202a, emissive: 0x500000, roughness: 0.25, userData: { lamp: 'tail' } });
    const amberMat = createGlossyMaterial({ color: 0xffa020, emissive: 0x4a2400, roughness: 0.25 });
    const fogMat = createGlossyMaterial({ color: 0xffe28a, emissive: 0x7a5410, roughness: 0.3, userData: { lamp: 'fog' } });
    const badgeMat = new THREE.MeshStandardMaterial({ color: 0xd01020, roughness: 0.4 });
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, metalness: 0.8, roughness: 0.35, side: THREE.DoubleSide });
    const shellMats = [bodyMat, glassMat, trimMat];

    const add = (geometry, material, x = 0, y = 0, z = 0) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        body.add(mesh);
        return mesh;
    };
    const box = (w, h, d, material, x, y, z) => add(new THREE.BoxGeometry(w, h, d), material, x, y, z);
    const slab = (corners, material, depth = 0.03) => add(slabGeometry(corners, depth), material);
    const slabPair = (corners, material, depth) => {
        slab(corners, material, depth);
        slab(mirrorX(corners), material, depth);
    };
    const forward = new THREE.Vector3(0, 0, 1);
    /** Thin box running from a to b. */
    const beam = (a, b, width, thickness, material) => {
        const from = new THREE.Vector3(...a);
        const to = new THREE.Vector3(...b);
        const mesh = box(width, thickness, from.distanceTo(to), material);
        mesh.position.copy(from).add(to).multiplyScalar(0.5);
        mesh.quaternion.setFromUnitVectors(forward, to.sub(from).normalize());
        return mesh;
    };

    // Shell
    add(lowerBodyGeometry(), shellMats);
    add(cabinGeometry(), shellMats);

    // Nose slope (z 2.22 → 2.1): point at `t` up the slope, lifted off the surface.
    const NOSE_LIFT = 0.01;
    const nose = (x, t) => [x, top(2.22) + 0.12 * t + NOSE_LIFT * 0.7, 2.22 - 0.12 * t + NOSE_LIFT * 0.7];
    slabPair([nose(0.3, 0.06), nose(0.64, 0.06), nose(0.73, 0.94), nose(0.4, 0.94)], lightMat, 0.04);
    slab([nose(-0.22, 0.18), nose(0.22, 0.18), nose(0.3, 0.86), nose(-0.3, 0.86)], trimMat, 0.03);
    slab([nose(-0.035, 0.38), nose(0.035, 0.38), nose(0.035, 0.66), nose(-0.035, 0.66)], badgeMat, 0.02);

    // Bumper face (z 2.22): big central mouth, corner pods with fogs, offset plate, splitter
    const FACE_Z = 2.228;
    const face = (x, y) => [x, y, FACE_Z];
    slab([face(-0.3, -0.22), face(0.3, -0.22), face(0.36, -0.06), face(-0.36, -0.06)], trimMat);
    slabPair([face(0.43, -0.22), face(0.66, -0.22), face(0.67, -0.05), face(0.41, -0.05)], trimMat);
    for (const side of [-1, 1]) {
        add(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 10), fogMat, side * 0.54, -0.1, FACE_Z + 0.005).rotation.x = Math.PI / 2;
    }
    box(0.27, 0.075, 0.012, plateMat, 0.54, -0.185, FACE_Z + 0.012);
    box(1.5, 0.025, 0.12, trimMat, 0, -0.26, 2.19);
    beam([-0.3, -0.13, FACE_Z + 0.005], [0.3, -0.13, FACE_Z + 0.005], 0.015, 0.012, bodyMat); // mouth crossbar

    // Bonnet: louvred central outlet and two outer cooling vents
    const BONNET_TILT = Math.atan2(0.14, 1.07);
    const onBonnet = (w, h, d, material, x, z, lift = 0) => {
        const mesh = box(w, h, d, material, x, top(z) + h / 2 - 0.008 + lift, z);
        mesh.rotation.x = BONNET_TILT;
        return mesh;
    };
    onBonnet(0.52, 0.025, 0.34, trimMat, 0, 1.55);
    for (let k = 0; k < 4; k++) onBonnet(0.5, 0.015, 0.025, bodyMat, 0, 1.43 + k * 0.08, 0.012);
    for (const side of [-1, 1]) onBonnet(0.2, 0.02, 0.16, trimMat, side * 0.48, 1.2);

    // Roof scoop (cabin ventilation)
    if (!road) {
        box(0.32, 0.045, 0.26, bodyMat, 0, 0.77, -0.32);
        box(0.26, 0.03, 0.015, trimMat, 0, 0.775, -0.185);
    }

    // Sides: belt seal, mirrors, door handles, mudflaps
    const SEAL_FRONT = 0.75;
    const SEAL_REAR = -0.95;
    for (const side of [-1, 1]) {
        beam(
            [side * 0.77, top(SEAL_FRONT) + 0.012, SEAL_FRONT],
            [side * 0.77, top(SEAL_REAR) + 0.012, SEAL_REAR],
            0.015, 0.025, trimMat
        );
        box(0.1, 0.03, 0.06, trimMat, side * 0.81, top(0.72) + 0.03, 0.72);    // mirror stalk
        box(0.07, 0.09, 0.15, bodyMat, side * 0.88, top(0.72) + 0.08, 0.7);    // mirror housing
        for (const z of [0.05, -0.75]) box(0.015, 0.03, 0.12, trimMat, side * (0.877 + flare(z)), 0.15, z);
        if (!road) for (const z of [0.85, -1.75]) box(0.3, 0.26, 0.012, trimMat, side * 0.72, -0.46, z);
    }

    // Rear face (z -2.19): taillights, centre garnish, plate, black lower valance, exhaust
    const TAIL_Z = -2.198;
    const rear = (x, y) => [x, y, TAIL_Z];
    slabPair([rear(0.73, 0.04), rear(0.48, 0.04), rear(0.48, 0.165), rear(0.74, 0.165)], tailMat, 0.04);
    slabPair([rear(0.47, 0.04), rear(0.33, 0.04), rear(0.33, 0.165), rear(0.47, 0.165)], amberMat, 0.04);
    slab([rear(0.31, 0.06), rear(-0.31, 0.06), rear(-0.31, 0.15), rear(0.31, 0.15)], trimMat, 0.02);
    slab([rear(0.7, -0.23), rear(-0.7, -0.23), rear(-0.7, -0.17), rear(0.7, -0.17)], trimMat, 0.02);
    box(0.52, 0.11, 0.012, plateMat, 0, -0.07, TAIL_Z - 0.004);
    const tailpipe = add(new THREE.CylinderGeometry(0.05, 0.05, 0.14, 10, 1, true), pipeMat, -0.5, -0.27, -2.17);
    tailpipe.rotation.x = Math.PI / 2;
    tailpipe.userData.exhaust = true;

    // Two-tier wing on the boot lid (road: one low plane)
    const WING_Z = -1.97;
    if (road) {
        for (const side of [-1, 1]) box(0.04, 0.08, 0.1, trimMat, side * 0.55, top(WING_Z) + 0.04, WING_Z);
        box(1.3, 0.03, 0.2, bodyMat, 0, top(WING_Z) + 0.09, WING_Z - 0.02).rotation.x = -0.05;
        return { group, bodyMat };
    }
    for (const side of [-1, 1]) {
        box(0.04, 0.12, 0.12, trimMat, side * 0.55, top(WING_Z) + 0.06, WING_Z);    // upright
        box(0.02, 0.24, 0.36, trimMat, side * 0.745, 0.5, WING_Z - 0.05);          // end plate
    }
    box(1.47, 0.035, 0.28, bodyMat, 0, 0.44, WING_Z - 0.02).rotation.x = -0.05; // main plane
    box(1.47, 0.025, 0.14, bodyMat, 0, 0.58, WING_Z - 0.1).rotation.x = -0.25;  // upper element

    return { group, bodyMat };
}
