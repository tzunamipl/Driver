import * as THREE from 'three';
import { lerpTable, loft, lowerBodyGeometry } from './impreza.js';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { DEFAULT_BODY_COLOR } from '../../../config.js';

// Ford Focus RS WRC (2001), low-poly: tall cab-forward five-door hatch,
// swept-back triangular headlights, flared arches, roof scoop, hatch wing,
// Martini stripes. Modelled for the 1.8 x 4 m chassis (wheels at z = ±1.3)
// and scaled like the Impreza bodies.

const REF_WIDTH = 1.8;
const REF_LENGTH = 4;

// Profiles as [z, value], z descending (nose -> tail).
const BODY_TOP = [
    [2.1, 0.0], [2.05, 0.08], [1.9, 0.17], [1.3, 0.26], [0.95, 0.31],
    [-1.55, 0.34], [-1.92, 0.33], [-1.98, 0.2],
];
const SHELL = {
    bottom: [[2.1, -0.2], [2.05, -0.3], [1.95, -0.35], [-1.92, -0.35], [-1.98, -0.3], [-2.0, -0.22]],
    halfWidth: [
        [2.1, 0.74], [2.02, 0.86], [1.8, 0.94], [0.92, 0.94], [0.8, 0.9],
        [-0.8, 0.9], [-0.92, 0.95], [-1.75, 0.95], [-1.95, 0.86], [-2.0, 0.8],
    ],
    noseZ: [2.1, 2.05, 1.95],
    tailZ: [-1.92, -1.98, -2.0],
    arch: { z: 1.3, y: -0.33, r: 0.4 },
};
// Greenhouse: steep windscreen from far forward, long flat roof, raked hatch glass.
const ROOF = [[0.95, 0.31], [0.1, 0.84], [-0.2, 0.86], [-1.35, 0.85], [-1.62, 0.76], [-1.85, 0.34]];
const STRIPE_COLORS = [0x0b1f4f, 0x2a7fd4, 0xd0102a]; // Martini dark blue, light blue, red

export function buildBody(chassisWidth, chassisLength, color = DEFAULT_BODY_COLOR) {
    const group = new THREE.Group();
    const body = new THREE.Group();
    body.scale.set(chassisWidth / REF_WIDTH, 1, chassisLength / REF_LENGTH);
    group.add(body);

    const bodyMat = createPaintMaterial(color, { metalness: 0.3, roughness: 0.45, flatShading: true });
    const glassMat = createGlossyMaterial({ color: 0x141c24, metalness: 0.5, roughness: 0.15, flatShading: true });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.8 });
    const lightMat = createGlossyMaterial({ color: 0xfff0c8, emissive: 0x403418, roughness: 0.2, userData: { lamp: 'head' } });
    const fogMat = createGlossyMaterial({ color: 0xfff6d8, emissive: 0x6a5420, roughness: 0.25, userData: { lamp: 'fog' } });
    const tailMat = createGlossyMaterial({ color: 0x9a1016, emissive: 0x2a0000, roughness: 0.3, userData: { lamp: 'tail' } });
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });
    const stripeMats = STRIPE_COLORS.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 }));

    const add = (geometry, material, x = 0, y = 0, z = 0) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        body.add(mesh);
        return mesh;
    };
    const box = (w, h, d, material, x, y, z) => add(new THREE.BoxGeometry(w, h, d), material, x, y, z);

    const belt = (z) => lerpTable(BODY_TOP, z) - 0.01;
    const roof = (z) => lerpTable(ROOF, z);
    /** Greenhouse half width: tumblehome with height, pinched at the hatch. */
    const TUMBLEHOME = 0.15 / 0.55; // greenhouse narrowing per metre of height
    const cabinHalfWidth = (y, z) => {
        const t = THREE.MathUtils.clamp((y - 0.31) / 0.55, 0, 1);
        const pinch = THREE.MathUtils.clamp((-1.3 - z) / 0.55, 0, 1);
        return (0.82 - 0.15 * t) * (1 - 0.08 * pinch);
    };

    // Shell + glass greenhouse.
    add(lowerBodyGeometry(BODY_TOP, SHELL), [bodyMat, trimMat]);
    add(loft(ROOF.map(([z, yt]) => {
        const yb = belt(z);
        const wb = cabinHalfWidth(yb, z);
        const wt = cabinHalfWidth(yt, z);
        return [[-wb, yb, z], [-wt, yt, z], [wt, yt, z], [wb, yb, z]];
    })), glassMat);

    // Roof panel with the WRC intake scoop, pillars in body colour / black.
    box(2 * cabinHalfWidth(0.86, -0.6) + 0.03, 0.035, 1.5, bodyMat, 0, 0.875, -0.62);
    box(0.32, 0.08, 0.3, bodyMat, 0, 0.92, 0.0);
    box(0.24, 0.05, 0.02, trimMat, 0, 0.925, 0.155);
    for (const side of [-1, 1]) {
        const edge = (z) => side * (cabinHalfWidth(roof(z), z) + 0.006);
        // A-pillar along the windscreen edge.
        const a = new THREE.Vector3(side * (cabinHalfWidth(0.31, 0.95) + 0.005), 0.31, 0.95);
        const b = new THREE.Vector3(edge(0.1), roof(0.1), 0.1);
        const pillar = box(0.07, 0.035, a.distanceTo(b), bodyMat);
        pillar.position.copy(a).add(b).multiplyScalar(0.5);
        pillar.lookAt(b);
        // Black B/C pillars and the body-colour D-pillar, leaning in with the glass.
        const onGlass = (mesh, z) => {
            mesh.position.x = side * (cabinHalfWidth(mesh.position.y, z) + 0.008);
            mesh.rotation.z = side * Math.atan(TUMBLEHOME);
            return mesh;
        };
        for (const z of [-0.3, -1.0]) onGlass(box(0.02, 0.5, 0.1, trimMat, 0, 0.58, z), z);
        onGlass(box(0.025, 0.42, 0.3, bodyMat, 0, 0.56, -1.45), -1.45);

        // Swept triangular headlight on the front corner, fog in the bumper.
        const head = box(0.42, 0.1, 0.03, lightMat, side * 0.55, 0.11, 2.0);
        head.rotation.set(-0.5, side * 0.45, side * -0.12);
        const fog = add(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 10), fogMat, side * 0.6, -0.2, 2.07);
        fog.rotation.x = Math.PI / 2;
        // Tall taillights up the D-pillars.
        box(0.12, 0.42, 0.05, tailMat, side * 0.74, 0.5, -1.86);

        box(0.08, 0.1, 0.14, bodyMat, side * 0.86, 0.42, 0.82); // mirror
        box(0.04, 0.06, 1.6, trimMat, side * 0.92, -0.3, 0); // side skirt
        box(0.3, 0.22, 0.02, trimMat, side * 0.72, -0.42, -1.75); // mud flap
        // Martini stripes along the doors, between the arches.
        stripeMats.forEach((material, i) => {
            box(0.012, 0.035, 1.7, material, side * (lerpTable(SHELL.halfWidth, 0) + 0.004), 0.06 - i * 0.05, 0);
        });
    }

    // Nose: small upper grille, big WRC intake, splitter; hatch wing and bumper.
    box(0.55, 0.06, 0.03, trimMat, 0, 0.06, 2.08);
    box(1.1, 0.16, 0.04, trimMat, 0, -0.17, 2.09);
    box(1.6, 0.03, 0.18, trimMat, 0, -0.34, 2.03);
    box(0.52, 0.11, 0.012, plateMat, 0, -0.04, 2.11);
    const wing = box(1.4, 0.04, 0.32, bodyMat, 0, 0.88, -1.62);
    wing.rotation.x = -0.12;
    for (const side of [-1, 1]) box(0.03, 0.12, 0.34, bodyMat, side * 0.7, 0.84, -1.62);
    box(1.0, 0.45, 0.02, trimMat, 0, 0.07, -1.99); // hatch shut-line / rear panel
    box(0.52, 0.11, 0.012, plateMat, 0, 0.0, -2.0);

    return { group, bodyMat };
}
