// Single source of truth for OSM road-class ("transportation" layer
// `class` field, see https://openmaptiles.org/schema/#transportation)
// render parameters, used by streets.js to draw the debug road overlay.
// Keeping every class's parameters here (instead of scattered through
// streets.js/vectorLineLayer.js) means adding a new parameter (e.g. an
// opacity or dash pattern) is a one-line change per class rather than a
// plumbing change.
//
// `widthMeters` is a real-world stripe width (drawn via LineMaterial's
// `worldUnits` mode - see vectorLineLayer.js - so a motorway reads as an
// actually-wide stripe on the ground rather than just a thicker line on
// screen), loosely modeled on typical paved width including
// shoulders/medians for that class; it's a debug-visualization aid, not a
// survey-accurate figure.

// Main hierarchy, ordered most -> least important. `color` is linearly
// interpolated between RED (first/most important) and GREY (last/least
// important) based on each class's position in this list; `widthMeters`
// is set explicitly per class below.
const RED = [0xff, 0x1a, 0x1a];
const GREY = [0x8a, 0x8a, 0x8a];

/** Linear-interpolates two [r, g, b] (0-255) triples at `t` (0..1) into a single 0xRRGGBB int. */
function lerpColor(a, b, t) {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return (r << 16) | (g << 8) | bl;
}

// Per-class parameters. Add new parameters here (not in streets.js) so
// every class picks up a sensible default and call sites stay untouched.
// `widthMeters` values are rough real-world paved widths (incl.
// shoulders/medians) for that class, used to size the ground stripe.
const ROAD_CLASS_DEFS = {
  motorway: { widthMeters: 14 },
  trunk: { widthMeters: 12 },
  primary: { widthMeters: 10 },
  secondary: { widthMeters: 8.5 },
  tertiary: { widthMeters: 7 },
  minor: { widthMeters: 6 },
  service: { widthMeters: 4 },
  track: { widthMeters: 3 },
  path: { widthMeters: 1.5 },
};
export const ROAD_HIERARCHY = Object.keys(ROAD_CLASS_DEFS);

// Narrowest a stripe is allowed to render, regardless of class/
// under-construction shrinkage - thin enough to still read as "minor",
// but never so thin it vanishes into a hairline.
const MIN_STRIPE_WIDTH = 1;

// `*_construction` variants (roads mid-build) reuse their finished
// class's style, just narrower, so they're still visually distinguishable
// as "not actually driveable yet".
const CONSTRUCTION_WIDTH_FACTOR = 0.6;

export const ROAD_CLASSES = {};
ROAD_HIERARCHY.forEach((cls, i) => {
  const t = i / (ROAD_HIERARCHY.length - 1);
  ROAD_CLASSES[cls] = {
    ...ROAD_CLASS_DEFS[cls],
    color: lerpColor(RED, GREY, t),
  };
});

// Special-purpose road classes that don't fit the main importance
// hierarchy - styled the same as the nearest-equivalent tier above
// (grey/thin "minor infrastructure" look) rather than getting their own
// slot in the red->grey gradient.
ROAD_CLASSES.busway = ROAD_CLASSES.bus_guideway = ROAD_CLASSES.service;
ROAD_CLASSES.raceway = ROAD_CLASSES.tertiary;

// Not a road at all (a shipping line) - not meaningful for a "streets" debug view.
export const SKIP_CLASSES = new Set(['ferry']);

/**
 * Maps one vector-tile feature's properties to a render style
 * ({key, color, width} in meters), or null if the feature isn't a
 * recognized road class. `_construction` suffixed classes resolve to
 * their finished class's style, narrowed by CONSTRUCTION_WIDTH_FACTOR.
 */
export function classifyRoad(props) {
  let cls = props?.class;
  if (!cls || SKIP_CLASSES.has(cls)) return null;

  let underConstruction = false;
  if (cls.endsWith('_construction')) {
    underConstruction = true;
    cls = cls.slice(0, -'_construction'.length);
  }

  const base = ROAD_CLASSES[cls];
  if (!base) return null; // unrecognized/rail-ish class - not a street

  const width = underConstruction
    ? Math.max(MIN_STRIPE_WIDTH, base.widthMeters * CONSTRUCTION_WIDTH_FACTOR)
    : base.widthMeters;

  return {
    key: underConstruction ? `${cls}_construction` : cls,
    color: base.color,
    width,
  };
}
