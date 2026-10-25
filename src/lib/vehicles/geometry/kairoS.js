import * as THREE from 'three';
import { buildKairoBody } from './kairo.js';
import { createGlossyMaterial } from './paint.js';

// Kairo S sedan: short roof, raked rear window, trunk deck,
// hood scoop, round fog lights and a trunk wing.
export const SEDAN = {
    rearTop: [[-1.4, 0.27], [-2.05, 0.3], [-2.14, 0.27], [-2.17, 0.15]],
    roofTail: (belt) => [[-0.95, 0.755], [-1.1, 0.73], [-1.55, belt(-1.55) + 0.005]],
    rearPinchZ: -0.9,
    roofEndZ: -1.0,
    rearPanel: (roof, belt) => [[-0.85, belt(-0.85)], [-0.95, roof(-0.95) - 0.045], [-1.1, roof(-1.1)], [-1.55, belt(-1.55) + 0.005]],
    rearFrame: [[-1.1, -1.55]],
    blackPillars: [-0.42],
    sealEndZ: -0.87,
    decorate({ add, box, materials }) {
        const fogMat = createGlossyMaterial({ color: 0xffe28a, emissive: 0x7a5410, roughness: 0.3, userData: { lamp: 'fog' } });

        // Hood scoop, following the hood's forward slope
        const scoop = box(0.46, 0.07, 0.4, materials.body, 0, 0.225, 1.25);
        scoop.rotation.x = 0.1;
        box(0.36, 0.04, 0.02, materials.trim, 0, 0.235, 1.455).rotation.x = 0.1;

        for (const side of [-1, 1]) {
            const fog = add(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 8), fogMat, side * 0.56, -0.13, 2.225);
            fog.rotation.x = Math.PI / 2;
            box(0.42, 0.13, 0.05, materials.tail, side * 0.53, 0.08, -2.17); // wide taillight
            box(0.05, 0.12, 0.08, materials.body, side * 0.6, 0.35, -1.98);  // wing strut
        }
        box(1.5, 0.035, 0.22, materials.body, 0, 0.425, -1.99).rotation.x = -0.08; // wing
        box(0.52, 0.11, 0.012, materials.plate, 0, -0.07, -2.18);
    },
};

export function buildBody(chassisWidth, chassisLength, color) {
    return buildKairoBody(chassisWidth, chassisLength, color, SEDAN);
}
