import { buildImprezaBody } from './impreza.js';

// Impreza GL NA wagon (GF): long roof, upright tailgate, roof rails.
const WAGON = {
    rearTop: [[-1.9, 0.27], [-2.12, 0.25], [-2.17, 0.15]],
    roofTail: (belt) => [[-1.6, 0.755], [-1.82, 0.73], [-2.06, belt(-2.06) + 0.005]],
    rearPinchZ: -1.6,
    roofEndZ: -1.84,
    rearPanel: (roof, belt) => [[-1.6, belt(-1.6)], [-1.72, roof(-1.72) - 0.045], [-1.82, roof(-1.82)], [-2.06, belt(-2.06) + 0.005]],
    rearFrame: [[-1.82, -2.06]],
    blackPillars: [-0.42, -1.22],
    sealEndZ: -1.62,
    decorate({ box, materials }) {
        for (const side of [-1, 1]) {
            box(0.05, 0.05, 1.45, materials.trim, side * 0.52, 0.815, -1.0); // roof rail
            box(0.26, 0.26, 0.05, materials.tail, side * 0.6, 0.03, -2.17);  // tall corner taillight
        }
        box(0.52, 0.11, 0.012, materials.plate, 0, 0.03, -2.18);
    },
};

export function buildBody(chassisWidth, chassisLength, color) {
    return buildImprezaBody(chassisWidth, chassisLength, color, WAGON);
}
