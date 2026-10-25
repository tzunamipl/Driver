import * as THREE from 'three';
import { lerpTable, loft, lowerBodyGeometry } from './kairo.js';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { DEFAULT_BODY_COLOR } from '../../../config.js';

// Halny five-door, low-poly: rounded sloping bonnet, big
// swept headlights, chrome-ringed grille, broad body-colour C-pillar,
// horizontal corner taillights. Modelled for the 1.8 x 4 m chassis (wheels
// at z = ±1.3) and scaled like the Kairo bodies.

const REF_WIDTH = 1.8;
const REF_LENGTH = 4;

// Profiles as [z, value], z descending (nose -> tail).
const BODY_TOP = [
    [2.15, 0.0], [2.1, 0.1], [1.95, 0.17], [1.3, 0.25], [0.95, 0.3],
    [-1.6, 0.37], [-1.92, 0.37], [-2.0, 0.28], [-2.05, 0.12],
];
const SHELL = {
    bottom: [[2.15, -0.2], [2.1, -0.3], [2.0, -0.35], [-1.95, -0.35], [-2.01, -0.3], [-2.05, -0.2]],
    halfWidth: [
        [2.15, 0.7], [2.08, 0.82], [1.9, 0.88], [-1.85, 0.88], [-1.98, 0.84], [-2.05, 0.78],
    ],
    noseZ: [2.15, 2.1, 2.0],
    tailZ: [-1.95, -2.01, -2.05],
    arch: { z: 1.3, y: -0.34, r: 0.39 },
};
// Windscreen from far forward, roof gently falling, raked hatch glass.
const ROOF = [[0.95, 0.3], [0.08, 0.84], [-0.25, 0.86], [-1.3, 0.83], [-1.6, 0.76], [-1.9, 0.38]];

/** Halny rally kit car: roof vent, light pod, mudflaps, arch extensions, hatch spoiler. */
export function buildRallyBody(chassisWidth, chassisLength, color) {
    return buildBody(chassisWidth, chassisLength, color, { rally: true });
}

export function buildBody(chassisWidth, chassisLength, color = DEFAULT_BODY_COLOR, { rally = false } = {}) {
    const group = new THREE.Group();
    const body = new THREE.Group();
    body.scale.set(chassisWidth / REF_WIDTH, 1, chassisLength / REF_LENGTH);
    group.add(body);

    const bodyMat = createPaintMaterial(color, { metalness: 0.45, roughness: 0.35, flatShading: true });
    const glassMat = createGlossyMaterial({ color: 0x10161c, metalness: 0.5, roughness: 0.12, flatShading: true });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.8 });
    const chromeMat = createGlossyMaterial({ color: 0xd8dade, metalness: 1, roughness: 0.15 });
    const lightMat = createGlossyMaterial({ color: 0xf4f6f8, emissive: 0x403418, roughness: 0.15, userData: { lamp: 'head' } });
    const fogMat = createGlossyMaterial({ color: 0xfff6d8, emissive: 0x6a5420, roughness: 0.25, userData: { lamp: 'fog' } });
    const tailMat = createGlossyMaterial({ color: 0xa8121a, emissive: 0x2a0000, roughness: 0.25, userData: { lamp: 'tail' } });
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
    const TUMBLEHOME = 0.16 / 0.55;
    const cabinHalfWidth = (y, z) => {
        const t = THREE.MathUtils.clamp((y - 0.3) / 0.55, 0, 1);
        const pinch = THREE.MathUtils.clamp((-1.3 - z) / 0.6, 0, 1);
        return (0.8 - 0.16 * t) * (1 - 0.1 * pinch);
    };

    add(lowerBodyGeometry(BODY_TOP, SHELL), [bodyMat, trimMat]);
    add(loft(ROOF.map(([z, yt]) => {
        const yb = belt(z);
        const wb = cabinHalfWidth(yb, z);
        const wt = cabinHalfWidth(yt, z);
        return [[-wb, yb, z], [-wt, yt, z], [wt, yt, z], [wb, yb, z]];
    })), glassMat);

    // Roof panel, short antenna, hatch spoiler lip.
    box(2 * cabinHalfWidth(0.86, -0.6) + 0.03, 0.035, 1.5, bodyMat, 0, 0.865, -0.6);
    box(0.02, 0.05, 0.12, trimMat, 0, 0.9, -1.25).rotation.x = -0.4;
    const lip = box(2 * cabinHalfWidth(0.78, -1.6), 0.03, 0.14, bodyMat, 0, 0.78, -1.6);
    lip.rotation.x = -0.15;
    for (const side of [-1, 1]) {
        const edge = (z) => side * (cabinHalfWidth(roof(z), z) + 0.006);
        const a = new THREE.Vector3(side * (cabinHalfWidth(0.3, 0.95) + 0.005), 0.3, 0.95);
        const b = new THREE.Vector3(edge(0.08), roof(0.08), 0.08);
        const pillar = box(0.07, 0.035, a.distanceTo(b), bodyMat);
        pillar.position.copy(a).add(b).multiplyScalar(0.5);
        pillar.lookAt(b);
        const onGlass = (mesh, z) => {
            mesh.position.x = side * (cabinHalfWidth(mesh.position.y, z) + 0.008);
            mesh.rotation.z = side * Math.atan(TUMBLEHOME);
            return mesh;
        };
        onGlass(box(0.02, 0.5, 0.1, trimMat, 0, 0.6, -0.4), -0.4);     // B-pillar
        onGlass(box(0.025, 0.42, 0.4, bodyMat, 0, 0.58, -1.38), -1.38); // broad C-pillar

        // Big swept headlight wrapping onto the wing; fog lights in the bumper.
        const head = box(0.36, 0.1, 0.03, lightMat, side * 0.5, 0.05, 2.12);
        head.rotation.set(-0.46, side * 0.25, 0); // lies on the raked nose face
        const fog = add(new THREE.CylinderGeometry(0.055, 0.055, 0.04, 10), fogMat, side * 0.6, -0.2, 2.13);
        fog.rotation.x = Math.PI / 2;
        // Horizontal taillights spanning the rear corners.
        const tail = box(0.36, 0.14, 0.05, tailMat, side * 0.6, 0.22, -2.01);
        tail.rotation.y = side * -0.25;

        box(0.08, 0.1, 0.16, bodyMat, side * 0.85, 0.42, 0.82); // mirror
        box(0.02, 0.025, 0.08, fogMat, side * 0.89, 0.4, 0.85); // mirror repeater
        box(0.02, 0.03, 1.3, chromeMat, side * 0.85, 0.355, -0.45); // window-line trim
    }

    // Nose: slim grille with badge, wide lower intake; rear: hatch, bumper, plate.
    box(0.62, 0.09, 0.03, trimMat, 0, 0.06, 2.13);
    add(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 16), chromeMat, 0, 0.07, 2.15).rotation.x = Math.PI / 2;
    box(0.9, 0.14, 0.04, trimMat, 0, -0.18, 2.15);
    box(0.52, 0.11, 0.012, plateMat, 0, -0.04, 2.16);
    add(new THREE.CylinderGeometry(0.055, 0.055, 0.02, 16), chromeMat, 0, 0.06, -2.06).rotation.x = Math.PI / 2;
    box(0.52, 0.11, 0.012, plateMat, 0, -0.1, -2.06);
    box(1.5, 0.12, 0.06, trimMat, 0, -0.27, -2.03); // lower rear valance

    if (rally) {
        box(0.3, 0.06, 0.26, trimMat, 0, 0.9, -0.1); // roof vent
        box(1.0, 0.16, 0.06, trimMat, 0, 0.12, 2.16); // light pod
        for (const x of [-0.33, 0, 0.33]) {
            add(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 10), fogMat, x, 0.12, 2.2).rotation.x = Math.PI / 2;
        }
        box(1.4, 0.035, 0.22, trimMat, 0, 0.8, -1.72).rotation.x = -0.25; // hatch spoiler
        for (const side of [-1, 1]) {
            for (const z of [1.3, -1.3]) {
                add(new THREE.CylinderGeometry(0.43, 0.43, 0.06, 12, 1, true, 0, Math.PI).rotateZ(Math.PI / 2), trimMat, side * 0.9, -0.34, z);
            }
            for (const z of [0.82, -1.78]) box(0.3, 0.24, 0.012, trimMat, side * 0.7, -0.44, z); // mudflaps
        }
    }

    return { group, bodyMat };
}
