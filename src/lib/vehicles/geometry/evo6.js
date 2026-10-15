import * as THREE from 'three';
import { buildImprezaBody } from './impreza.js';
import { createGlossyMaterial } from './paint.js';

// Lancer Evolution VI in Group A rally trim: sedan shell with a big-mouth
// bumper, offset plate, vented bonnet, roof scoop, two-tier wing, mudflaps.
const EVO_SEDAN = {
    rearTop: [[-1.4, 0.27], [-2.05, 0.3], [-2.14, 0.27], [-2.17, 0.15]],
    roofTail: (belt) => [[-0.95, 0.755], [-1.1, 0.73], [-1.55, belt(-1.55) + 0.005]],
    rearPinchZ: -0.9,
    roofEndZ: -1.0,
    rearPanel: (roof, belt) => [[-0.85, belt(-0.85)], [-0.95, roof(-0.95) - 0.045], [-1.1, roof(-1.1)], [-1.55, belt(-1.55) + 0.005]],
    rearFrame: [[-1.1, -1.55]],
    blackPillars: [-0.42],
    sealEndZ: -0.87,
    frontPlate: [0.42, -0.2],
    decorate({ box, materials }) {
        const { body, trim, tail } = materials;
        const fogMat = createGlossyMaterial({ color: 0xffe28a, emissive: 0x7a5410, roughness: 0.3 });

        // Front: wide central intake, corner intakes with fog lights, splitter
        box(0.62, 0.13, 0.03, trim, -0.08, -0.17, 2.235);
        for (const side of [-1, 1]) {
            box(0.2, 0.1, 0.03, trim, side * 0.6, -0.08, 2.23);
            box(0.12, 0.07, 0.02, fogMat, side * 0.6, -0.08, 2.245);
        }
        box(1.6, 0.025, 0.14, trim, 0, -0.33, 2.17);

        // Bonnet: central scoop plus twin heat-extraction vents
        const scoop = box(0.34, 0.05, 0.28, body, 0, 0.2, 1.65);
        scoop.rotation.x = 0.1;
        box(0.26, 0.03, 0.02, trim, 0, 0.21, 1.79).rotation.x = 0.1;
        for (const side of [-1, 1]) {
            box(0.28, 0.02, 0.22, trim, side * 0.36, 0.19, 1.25).rotation.x = 0.1;
        }

        // Roof scoop (cabin ventilation)
        box(0.3, 0.05, 0.24, body, 0, 0.815, -0.35);
        box(0.24, 0.035, 0.02, trim, 0, 0.815, -0.225);

        // Rear: full-width taillights, two-tier wing
        for (const side of [-1, 1]) {
            box(0.46, 0.12, 0.05, tail, side * 0.5, 0.12, -2.17);
            box(0.05, 0.14, 0.1, trim, side * 0.55, 0.37, -1.98);  // wing strut
            box(0.02, 0.14, 0.34, trim, side * 0.75, 0.47, -2.01); // end plate
        }
        box(1.48, 0.035, 0.28, body, 0, 0.445, -2.0).rotation.x = -0.06; // main plane
        box(1.48, 0.025, 0.12, body, 0, 0.51, -2.09).rotation.x = -0.3;  // upper flap
        box(0.52, 0.11, 0.012, materials.plate, 0, -0.07, -2.18);

        // Mudflaps behind each wheel
        for (const side of [-1, 1]) {
            for (const z of [0.86, -1.74]) box(0.3, 0.24, 0.012, trim, side * 0.72, -0.44, z);
        }
    },
};

export function buildBody(chassisWidth, chassisLength, color) {
    return buildImprezaBody(chassisWidth, chassisLength, color, EVO_SEDAN);
}
