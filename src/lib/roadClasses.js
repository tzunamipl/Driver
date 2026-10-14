// Road style per OpenMapTiles transportation `class` for the streets
// overlay. widthMeters is a rough real paved width (incl. shoulders),
// drawn as a flat ground stripe and used for road surface detection.

// Most -> least important; colour runs red -> grey along this list.
const RED = [0xff, 0x1a, 0x1a];
const GREY = [0x8a, 0x8a, 0x8a];

/** Lerps two [r, g, b] (0-255) triples into a 0xRRGGBB int. */
function lerpColor(a, b, t) {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return (r << 16) | (g << 8) | bl;
}

// Per-class parameters (add new ones here). smoothMeters = window the
// terrain road bed averages the elevation over along the road (0 = exact).
const ROAD_CLASS_DEFS = {
  motorway: { widthMeters: 28, smoothMeters: 150 },
  trunk: { widthMeters: 24, smoothMeters: 120 },
  primary: { widthMeters: 20, smoothMeters: 80 },
  secondary: { widthMeters: 17, smoothMeters: 40 },
  tertiary: { widthMeters: 14 },
  minor: { widthMeters: 12 },
  service: { widthMeters: 4 },
  track: { widthMeters: 3 },
  path: { widthMeters: 1.5 },
};
export const ROAD_HIERARCHY = Object.keys(ROAD_CLASS_DEFS);

const MIN_STRIPE_WIDTH = 1;

// `*_construction` classes: the finished class's style, narrower.
const CONSTRUCTION_WIDTH_FACTOR = 0.6;

export const ROAD_CLASSES = {};
ROAD_HIERARCHY.forEach((cls, i) => {
  const t = i / (ROAD_HIERARCHY.length - 1);
  ROAD_CLASSES[cls] = {
    ...ROAD_CLASS_DEFS[cls],
    color: lerpColor(RED, GREY, t),
  };
});

// Special-purpose classes styled like the minor tier.
ROAD_CLASSES.busway = ROAD_CLASSES.bus_guideway = ROAD_CLASSES.service;
ROAD_CLASSES.raceway = ROAD_CLASSES.tertiary;

// Shipping lines aren't roads.
export const SKIP_CLASSES = new Set(['ferry']);

/** Feature props -> { key, color, width (m), smoothMeters }, or null if not a road class. */
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
    smoothMeters: base.smoothMeters ?? 0,
  };
}
