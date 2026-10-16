import * as THREE from 'three';
import { buildImprezaBody } from './impreza.js';
import { SEDAN } from './gc8.js';
import { createGlossyMaterial } from './paint.js';

// Impreza 22B STi: the GC8 coupe with bolt-on widebody arches, a deep front
// lip, a bigger hood scoop and the tall adjustable rear wing.
const COUPE_22B = {
    ...SEDAN,
    blackPillars: [-0.6], // long two-door glass, B-pillar well back
    bodyHalfWidth: [
        [2.22, 0.77], [2.15, 0.87], [1.9, 0.96], [0.95, 0.96], [0.85, 0.93],
        [-0.85, 0.93], [-0.95, 0.97], [-1.9, 0.97], [-2.12, 0.87], [-2.17, 0.81],
    ],
    decorate({ add, box, materials }) {
        const fogMat = createGlossyMaterial({ color: 0xffe28a, emissive: 0x7a5410, roughness: 0.3, userData: { lamp: 'fog' } });

        const scoop = box(0.56, 0.09, 0.48, materials.body, 0, 0.235, 1.25);
        scoop.rotation.x = 0.1;
        box(0.46, 0.05, 0.02, materials.trim, 0, 0.245, 1.495).rotation.x = 0.1;
        box(1.62, 0.04, 0.16, materials.trim, 0, -0.33, 2.17); // front lip

        for (const side of [-1, 1]) {
            const fog = add(new THREE.CylinderGeometry(0.075, 0.075, 0.04, 10), fogMat, side * 0.58, -0.13, 2.225);
            fog.rotation.x = Math.PI / 2;
            box(0.42, 0.13, 0.05, materials.tail, side * 0.53, 0.08, -2.17);
            // Arch lips: thin body-colour rims at the widened wheel openings.
            for (const z of [1.3, -1.3]) box(0.05, 0.05, 0.8, materials.body, side * 0.95, -0.01, z);
            // Tall wing: struts up from the trunk, end plates at the tips.
            box(0.05, 0.22, 0.1, materials.body, side * 0.58, 0.41, -1.98);
            box(0.02, 0.12, 0.3, materials.body, side * 0.79, 0.54, -2.02);
        }
        box(1.58, 0.035, 0.28, materials.body, 0, 0.53, -2.02).rotation.x = -0.1;
        box(0.52, 0.11, 0.012, materials.plate, 0, -0.07, -2.18);
    },
};

export function buildBody(chassisWidth, chassisLength, color) {
    return buildImprezaBody(chassisWidth, chassisLength, color, COUPE_22B);
}
