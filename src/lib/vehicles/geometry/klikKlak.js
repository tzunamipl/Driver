import * as THREE from 'three';
import { lerpTable, loft, lowerBodyGeometry } from './kairo.js';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { DEFAULT_BODY_COLOR } from '../../../config.js';

// KlikKlak, low-poly: upright 3.2 m three-door box, short
// flat bonnet, near-vertical tailgate, thick C-pillar, black plastic bumpers
// and rubbing strips, small square headlights. Its own short wheelbase
// (axles at z = ±AXLE_Z); not scaled to the shared chassis.

export const AXLE_Z = 1.1;

// Profiles as [z, value], z descending (nose -> tail).
const BODY_TOP = [
    [1.66, 0.12], [1.6, 0.19], [1.45, 0.22], [0.78, 0.29],
    [-1.4, 0.33], [-1.54, 0.33], [-1.6, 0.24],
];
const SHELL = {
    bottom: [[1.66, -0.22], [1.6, -0.32], [1.5, -0.35], [-1.5, -0.35], [-1.56, -0.31], [-1.6, -0.22]],
    halfWidth: [[1.66, 0.64], [1.6, 0.71], [1.48, 0.745], [-1.48, 0.745], [-1.56, 0.72], [-1.6, 0.69]],
    noseZ: [1.66, 1.6, 1.5],
    tailZ: [-1.5, -1.56, -1.6],
    arch: { z: AXLE_Z, y: -0.33, r: 0.33 },
};
// Raked windscreen, dead-flat roof, tailgate glass almost upright.
const ROOF = [[0.78, 0.29], [0.08, 0.8], [-0.1, 0.82], [-1.36, 0.82], [-1.48, 0.77], [-1.54, 0.34]];

export function buildBody(chassisWidth, chassisLength, color = DEFAULT_BODY_COLOR) {
    const group = new THREE.Group();
    const body = new THREE.Group();
    group.add(body);

    const bodyMat = createPaintMaterial(color, { metalness: 0.1, roughness: 0.5, flatShading: true });
    const glassMat = createGlossyMaterial({ color: 0x18222a, metalness: 0.5, roughness: 0.15, flatShading: true });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.85 });
    const lightMat = createGlossyMaterial({ color: 0xf2f0e6, emissive: 0x403418, roughness: 0.2, userData: { lamp: 'head' } });
    const indicatorMat = new THREE.MeshStandardMaterial({ color: 0xe08a1a, emissive: 0x3a1c00, roughness: 0.4 });
    const tailMat = createGlossyMaterial({ color: 0x9a1016, emissive: 0x2a0000, roughness: 0.3, userData: { lamp: 'tail' } });
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });

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
    const TUMBLEHOME = 0.1 / 0.52;
    const cabinHalfWidth = (y, z) => {
        const t = THREE.MathUtils.clamp((y - 0.29) / 0.52, 0, 1);
        const pinch = THREE.MathUtils.clamp((-1.2 - z) / 0.35, 0, 1);
        return (0.68 - 0.1 * t) * (1 - 0.04 * pinch);
    };

    add(lowerBodyGeometry(BODY_TOP, SHELL), [bodyMat, trimMat]);
    add(loft(ROOF.map(([z, yt]) => {
        const yb = belt(z);
        const wb = cabinHalfWidth(yb, z);
        const wt = cabinHalfWidth(yt, z);
        return [[-wb, yb, z], [-wt, yt, z], [wt, yt, z], [wb, yb, z]];
    })), glassMat);

    // Roof panel and pillars.
    box(2 * cabinHalfWidth(0.82, -0.6) + 0.03, 0.035, 1.42, bodyMat, 0, 0.835, -0.66);
    for (const side of [-1, 1]) {
        const edge = (z) => side * (cabinHalfWidth(roof(z), z) + 0.006);
        const a = new THREE.Vector3(side * (cabinHalfWidth(0.29, 0.78) + 0.005), 0.29, 0.78);
        const b = new THREE.Vector3(edge(0.08), roof(0.08), 0.08);
        const pillar = box(0.06, 0.03, a.distanceTo(b), bodyMat);
        pillar.position.copy(a).add(b).multiplyScalar(0.5);
        pillar.lookAt(b);
        const onGlass = (mesh, z) => {
            mesh.position.x = side * (cabinHalfWidth(mesh.position.y, z) + 0.008);
            mesh.rotation.z = side * Math.atan(TUMBLEHOME);
            return mesh;
        };
        onGlass(box(0.02, 0.5, 0.08, trimMat, 0, 0.56, -0.62), -0.62); // B-pillar
        onGlass(box(0.025, 0.5, 0.26, bodyMat, 0, 0.56, -1.3), -1.3);  // thick C-pillar

        // Small square headlight + amber indicator on the flat nose.
        box(0.32, 0.15, 0.03, lightMat, side * 0.42, 0.04, 1.67);
        box(0.08, 0.15, 0.03, indicatorMat, side * 0.595, 0.04, 1.665);
        // Upright taillight clusters in the rear corners.
        box(0.18, 0.24, 0.04, tailMat, side * 0.58, 0.08, -1.605);

        box(0.06, 0.09, 0.12, trimMat, side * 0.72, 0.38, 0.7);       // mirror
        box(0.03, 0.08, 2.0, trimMat, side * 0.755, -0.05, -0.02);    // rubbing strip
        box(0.03, 0.1, 0.06, indicatorMat, side * 0.75, 0.08, 1.5);   // side repeater
    }

    // Nose: grille slot, wraparound black bumpers front and rear, plates.
    box(0.46, 0.08, 0.02, trimMat, 0, 0.06, 1.665);
    box(1.4, 0.16, 0.12, trimMat, 0, -0.2, 1.66);
    box(0.52, 0.11, 0.012, plateMat, 0, -0.2, 1.725);
    box(1.4, 0.18, 0.12, trimMat, 0, -0.2, -1.6);
    box(0.52, 0.11, 0.012, plateMat, 0, 0.05, -1.605);
    box(1.0, 0.02, 0.02, trimMat, 0, 0.3, -1.59); // tailgate shut-line

    return { group, bodyMat };
}
