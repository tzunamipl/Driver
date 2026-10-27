import * as THREE from 'three';
import { buildKairoBody } from './kairo.js';
import { createGlossyMaterial } from './paint.js';

// Kairo Wagon Mk2: the modern Kairo Wagon - slim swept headlights, bigger hex
// grille, rising beltline, raked D-pillar with a roof spoiler, flush roof rails,
// low hood scoop, light bar between the tail lamps, black lower trim.
// Thin blade lamps swept well back onto the wings.
const HEADLIGHT = [
    [[0.3, 0.015, 2.23], [0.31, 0.045, 2.2]],
    [[0.5, 0.01, 2.225], [0.5, 0.05, 2.198]],
    [[0.7, 0.0, 2.215], [0.71, 0.045, 2.192]],
    [[0.8, -0.005, 2.19], [0.81, 0.035, 2.17]],
    [[0.875, 0.0, 2.08], [0.87, 0.03, 2.07]],
    [[0.9, 0.005, 1.95], [0.895, 0.025, 1.95]],
];
const GRILLE = [
    [[-0.22, -0.07, 2.24], [-0.33, -0.01, 2.24], [-0.3, 0.045, 2.2]],
    [[0.22, -0.07, 2.24], [0.33, -0.01, 2.24], [0.3, 0.045, 2.2]],
];

const WAGON_MK2 = {
    headlight: HEADLIGHT,
    grille: GRILLE,
    windshieldZ: 0.98,
    rearTop: [[-1.5, 0.29], [-2.0, 0.32], [-2.12, 0.29], [-2.17, 0.16]],
    roofTail: (belt) => [[-1.5, 0.755], [-1.74, 0.725], [-2.1, belt(-2.1) + 0.005]],
    rearPinchZ: -1.5,
    roofEndZ: -1.76,
    rearPanel: (roof, belt) => [[-1.5, belt(-1.5)], [-1.62, roof(-1.62) - 0.045], [-1.74, roof(-1.74)], [-2.1, belt(-2.1) + 0.005]],
    rearFrame: [[-1.74, -2.1]],
    blackPillars: [-0.42, -1.15],
    sealEndZ: -1.52,
    decorate({ add, box, materials, roof }) {
        const fogMat = createGlossyMaterial({ color: 0xffe28a, emissive: 0x7a5410, roughness: 0.3, userData: { lamp: 'fog' } });

        // Low, wide hood scoop
        const scoop = box(0.6, 0.045, 0.42, materials.body, 0, 0.215, 1.2);
        scoop.rotation.x = 0.1;
        box(0.5, 0.03, 0.02, materials.trim, 0, 0.225, 1.41).rotation.x = 0.1;

        for (const side of [-1, 1]) {
            box(0.16, 0.035, 0.03, fogMat, side * 0.6, -0.2, 2.225);           // slim fog lamp
            box(0.025, 0.09, 1.75, materials.trim, side * 0.905, -0.29, 0);    // black side skirt
            for (const z of [1.3, -1.3]) {
                const arch = add(new THREE.TorusGeometry(0.39, 0.035, 4, 4, Math.PI), materials.trim, side * 0.9, -0.34, z);
                arch.rotation.y = Math.PI / 2; // arch cladding
            }
            box(0.04, 0.03, 1.5, materials.trim, side * 0.55, 0.8, -0.85);     // flush roof rail
            box(0.36, 0.08, 0.05, materials.tail, side * 0.6, 0.2, -2.16);     // wraparound tail lamp
            const pipe = add(new THREE.CylinderGeometry(0.04, 0.04, 0.08, 8), materials.trim, side * 0.45, -0.3, -2.19);
            pipe.rotation.x = Math.PI / 2;
            pipe.userData.exhaust = true;
        }
        box(0.84, 0.02, 0.02, materials.tail, 0, 0.2, -2.165);                 // light bar
        box(1.3, 0.025, 0.16, materials.body, 0, roof(-1.74) + 0.03, -1.82).rotation.x = -0.12; // roof spoiler
        box(1.2, 0.06, 0.08, materials.trim, 0, -0.3, -2.15);                  // rear diffuser
        box(0.52, 0.11, 0.012, materials.plate, 0, 0.0, -2.18);
    },
};

export function buildBody(chassisWidth, chassisLength, color) {
    return buildKairoBody(chassisWidth, chassisLength, color, WAGON_MK2);
}
