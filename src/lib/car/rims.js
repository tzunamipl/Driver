// Rim library: procedural low-poly rim styles (geometry in ./rimMesh.js): an outer belt the full
// wheel width, a plain body (no thickness) with the pattern cut out, and a central hub on the body.
//   style: 'holes' (steel rim: a body with `count` windows), 'solid' (closed body / hubcap) or
//     'spokes' (`count` flat spokes between hub and belt).
//   face: 'flat', 'convex' (centre bulges out) or 'concave' (centre dished in), a 3-segment curve;
//     dish = how far the centre sits out / in, as a share of the rim width.
//   depth: how far the body's outer edge sits in from the belt's outer edge, share of the rim
//     width; the hub follows the body. hub: hub diameter, share of the rim diameter.
//   holeSize: share of each sector open (holes); spokeWidth: share of each sector a spoke fills;
//   twist: spoke sweep from hub to rim (rad). color: the rim's own paint, over the car's rimColor.
// A descriptor picks one per tyre compound group: `rims: { default, tarmac, loose, allRound, winter }`
// (ids from RIMS); the player's tyre setup can override it (`rim`, `rimColor`).
import { getTyreCompound } from '../tyres/compounds.js';

export const RIMS = {
  steel4: { label: 'Steel, 4 holes', style: 'holes', count: 4, face: 'convex', dish: 0.15, depth: 0.25, hub: 0.3, holeSize: 0.4 },
  steel6: { label: 'Steel, 6 holes', style: 'holes', count: 6, face: 'convex', dish: 0.12, depth: 0.3, hub: 0.3, holeSize: 0.35 },
  steel8: { label: 'Steel, 8 holes', style: 'holes', count: 8, face: 'concave', dish: 0.1, depth: 0.15, hub: 0.3, holeSize: 0.3 },
  steelBlack: { label: 'Black steel', style: 'holes', count: 6, face: 'convex', dish: 0.12, depth: 0.3, hub: 0.3, holeSize: 0.35, color: 0x1c1c1c },
  truck: { label: 'Truck steel', style: 'holes', count: 10, face: 'concave', dish: 0.35, depth: 0.05, hub: 0.35, holeSize: 0.3 },
  hubcap: { label: 'Hubcap', style: 'solid', face: 'convex', dish: 0.2, depth: 0.15, hub: 0.2 },
  disc: { label: 'Aero disc', style: 'solid', face: 'flat', depth: 0.15, hub: 0.25 },
  spoke3: { label: '3 spoke', style: 'spokes', count: 3, face: 'convex', dish: 0.15, depth: 0.1, hub: 0.3, spokeWidth: 0.25 },
  spoke4: { label: '4 spoke classic', style: 'spokes', count: 4, face: 'convex', dish: 0.1, depth: 0.2, hub: 0.3, spokeWidth: 0.45 },
  spoke5: { label: '5 spoke', style: 'spokes', count: 5, face: 'concave', dish: 0.2, depth: 0.1, hub: 0.28, spokeWidth: 0.35 },
  spoke5Twist: { label: '5 spoke twist', style: 'spokes', count: 5, face: 'concave', dish: 0.15, depth: 0.1, hub: 0.25, spokeWidth: 0.3, twist: 0.35 },
  rally6: { label: 'Rally 6 spoke', style: 'spokes', count: 6, face: 'flat', depth: 0.25, hub: 0.3, spokeWidth: 0.5 },
  rally8: { label: 'Rally 8 spoke', style: 'spokes', count: 8, face: 'concave', dish: 0.1, depth: 0.2, hub: 0.3, spokeWidth: 0.45 },
  mesh10: { label: '10 spoke', style: 'spokes', count: 10, face: 'concave', dish: 0.3, depth: 0.05, hub: 0.25, spokeWidth: 0.35 },
  deepDish: { label: 'Deep dish', style: 'spokes', count: 8, face: 'flat', depth: 0.55, hub: 0.3, spokeWidth: 0.4 },
  beadlock: { label: 'Beadlock', style: 'holes', count: 8, face: 'flat', depth: 0, hub: 0.35, holeSize: 0.45, color: 0x2a2a2a },
};

export const RIM_IDS = Object.keys(RIMS);
export const DEFAULT_RIM = 'steel6';
/** Tyre setup `rim` value: the car's own rim for the fitted compound. */
export const AUTO_RIM = 'auto';
const DEFAULT_RIM_COLOR = 0xc0c0c0;

// Compound group label (tyres/compounds.js) -> descriptor `rims` key.
const GROUP_KEYS = { Tarmac: 'tarmac', Loose: 'loose', 'All-round': 'allRound', Winter: 'winter' };

/** The car's own rim id for a tyre compound. */
export function stockRimId(descriptor, compoundId) {
  const rims = descriptor.rims ?? {};
  const id = rims[GROUP_KEYS[getTyreCompound(compoundId).group]] ?? rims.default;
  return RIMS[id] ? id : DEFAULT_RIM;
}

/** { rimStyle, rimColor } a wheel spec shows: the tyre setup's pick, else the car's rim for its compound. */
export function resolveRim(spec) {
  const pick = spec.tyreSetup?.rim;
  const id = RIMS[pick] ? pick : stockRimId(spec, spec.tyreCompound);
  const rimStyle = RIMS[id];
  return { rimStyle, rimColor: spec.tyreSetup?.rimColor ?? rimStyle.color ?? spec.rimColor ?? DEFAULT_RIM_COLOR };
}
