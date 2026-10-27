// OSM roads as flat stripes coloured/sized by class (roadClasses.js),
// debug overlay on the K key. Always streams: surfaceAt() drives the
// road/unpaved tyre-grip surface (terrainSurface.js). Plumbing: vectorLineLayer.js.
// Settings road surface view: the same stripes, so exactly where the tyres feel
// tarmac, drawn as asphalt / gravel for the roads carved into a road bed, within
// SURFACE_RADIUS_M of the car.

import { Color, Mesh, MeshBasicMaterial, MeshStandardMaterial, Vector2 } from 'three';
import { createVectorLineLayer } from './vectorLineLayer.js';
import { classifyRoad, ROAD_CLASSES, ROAD_HIERARCHY } from './roadClasses.js';
import { DETAIL_BOX, DETAIL_ZOOM, GROUND_RENDER_ORDER, applyGroundHaze } from './terrain.js';
import { onRoadBed } from './terrain/roadBed.js';
import { tileSizeMeters } from './geo.js';
import { getWetness, onWeatherChange } from './weather.js';

// The transportation layer's maxzoom.
const STREET_TILE_ZOOM = 14;

// Lift above ground, against z-fighting.
const STREET_LIFT = 0.2;

// Surface view: on the road bed itself; the depth bias keeps it in front of the terrain. It writes no
// depth, so cars are tested against the terrain and never sink into the biased stripes.
// Depth bias: drawn this much nearer the camera than they are (metres, plus a share of the distance),
// so the bed bulging between height samples doesn't poke through. Not polygonOffset: three
// flips only its factor for the reversed depth buffer, and log depth ignores it.
const DEPTH_BIAS_PER_M = 0.05;
// Overlapping stripes (junctions) go by draw order (one mesh per class rank, higher on top); this keeps ranks apart from the terrain too.
const DEPTH_BIAS_PER_RANK = 0.015;
// Classes on the road bed, highest first: the only ones in the surface view.
const BED_HIERARCHY = ROAD_HIERARCHY.filter((cls) => onRoadBed(cls));
// Surface view only around the car, dissolving out over the last FADE metres.
const SURFACE_RADIUS_M = 400;
const SURFACE_FADE_M = 100;
const surfaceCenter = { value: new Vector2() };
// Surface patches: blotchy value noise over the colour (no texture), cell sizes in metres, coarse to fine.
// The pattern tiles every PATCH_PERIOD_M (cell sizes divide it); the origin offset is kept modulo it, so it stays put across rebases.
const PATCH_CELLS_M = [24, 6, 1.5];
const PATCH_PERIOD_M = 1536;
const patchOffset = { value: new Vector2() };
// Wet look (lib/weather.js wetness): darker, glossier, sky glint at grazing angles; puddles once past
// PUDDLES_FROM, above a noise threshold that drops to soaked. Low-poly: the noise is linear over triangles
// (cell sizes divide PATCH_PERIOD_M and each other, so octaves share the finest triangles), giving
// straight-edged puddles with crisp borders, each triangle tinted by up to PUDDLE_FACET_SHADE.
const roadWetness = { value: getWetness() };
onWeatherChange(({ wetness }) => {
  roadWetness.value = wetness;
});
const PUDDLE_CELLS_M = [8, 2];
const PUDDLES_FROM = 0.5;
const PUDDLE_THRESHOLD = { from: 0.8, soaked: 0.72 };
const PUDDLE_SHEEN = 0.45;
const PUDDLE_FACET_SHADE = 0.12;
// Specular scale when soaked (1 = three.js default); more blows the sun's glint out.
const WET_SPECULAR = 0.3;
// Sun behind the cloud deck (clouds.js overcast share): the glint spreads out to this roughness;
// soaked roads keep this share of their sharpness, as they mirror the bright sky.
const roadOvercast = { value: 0 };
const OVERCAST_ROUGHNESS = 0.92;
const OVERCAST_WET_HOLD = 0.5;

/** Overcast share 0..1 (clouds.js deck cover). */
export function setRoadOvercast(share) {
  roadOvercast.value = share;
}

// Road markings on asphalt (flag bits in the style's `markings`): solid edge lines on the
// higher classes, a dashed centre line on most two-way roads; faded out at junctions.
const MARK_EDGES = 1;
const MARK_CENTRE = 2;
const MARK_TWO_LANES = 4; // edge lines hug two painted lanes; the centre line divides them, one-way or not
const MARK_ONE_LANE = 8; // slip roads (`ramp`): edge lines hug one lane, no centre line
const EDGE_LINE_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary']);
const TWO_LANE_CLASSES = new Set(['motorway', 'trunk']);
const CENTRE_LINE_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']);
const MARKING = {
  color: new Color(0xe6e6df),
  edgeWidth: 0.15,
  edgeInset: 0.5, // edge line centre in from the stripe's side (the widths include a shoulder)
  laneWidth: 3.5, // two-lane roads: edge lines this far either side of the centre line
  centreWidth: 0.12,
  dash: 3, // centre line: painted metres per period
  period: 9,
  junctionGap: 1, // clear of a junction's widest road by this, then
  junctionRamp: 3, // fading in over this
};

// Asphalt keeps a sheen for the sun, moon and lamps; gravel is near matte.
// patches = colour swing of the surface patches (share of the colour, either way).
// wet = soaked look: darken (colour share kept), roughness, sheen (sky reflection strength).
// blobs = polka-dot layers: diameterM = largest dot (metres), density = share of grid cells with a dot,
// swing = colour swing (share of the colour; each dot lighter or darker at random).
const SURFACE_LOOKS = {
  paved: {
    color: 0x47484c, roughness: 0.78, specular: 0.35, lift: 0, depthBias: 0.12, markings: true, patches: 0.14,
    wet: { darken: 0.55, roughness: 0.42, sheen: 0.15 },
    blobs: [{ diameterM: 2.5, density: 0.35, swing: 0.2 }, { diameterM: 0.6, density: 0.5, swing: 0.08 }],
  },
  unpaved: {
    color: 0x9c8868, roughness: 0.9, specular: 0.15, lift: 0, depthBias: 0.13, patches: 0.8,
    wet: { darken: 0.6, roughness: 0.5, sheen: 0.06 },
    blobs: [{ diameterM: 3, density: 0.4, swing: 0.2 }, { diameterM: 0.2, density: 0.8, swing: 0.25 }],
  },
};
// Blob dots: smallest diameter as a share of the layer's diameterM.
const BLOB_MIN_SCALE = 0.5;
// Blob layers fade out as a grid cell shrinks from the first to the second on-screen size (pixels).
const BLOB_FADE_PX = [2, 1];

/** Ground decals over the surface view (car contact shadows) need more depth bias than this. */
export const SURFACE_DEPTH_BIAS =
  Math.max(...Object.values(SURFACE_LOOKS).map((look) => look.depthBias)) + (BED_HIERARCHY.length - 1) * DEPTH_BIAS_PER_RANK;

/**
 * Draws a material `metres` (plus DEPTH_BIAS_PER_M of the distance) nearer the camera: slid along the view ray,
 * so same pixel, nearer depth. `ranked`: plus DEPTH_BIAS_PER_RANK per unit of the `depthRank` attribute.
 */
export function applyDepthBias(shader, metres, ranked = false) {
  const bias = ranked ? `(${metres.toFixed(3)} + depthRank * ${DEPTH_BIAS_PER_RANK.toFixed(3)})` : metres.toFixed(3);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', ranked ? '#include <common>\nattribute float depthRank;' : '#include <common>')
    .replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      float viewDist = length(mvPosition.xyz);
      gl_Position = projectionMatrix * vec4(mvPosition.xyz * max(0.0, 1.0 - ${bias} / viewDist - ${DEPTH_BIAS_PER_M.toFixed(4)}), 1.0);`
    );
}

/** Junction draw order of a class key: 0 for the lowest class, up to the motorway's (aliases rank as their base class). */
function depthRankOf(key) {
  const def = ROAD_CLASSES[key.replace(/_construction$/, '')];
  const index = BED_HIERARCHY.findIndex((cls) => ROAD_CLASSES[cls] === def);
  return index < 0 ? 0 : BED_HIERARCHY.length - 1 - index;
}

const surfaceMaterials = Object.fromEntries(
  Object.entries(SURFACE_LOOKS).map(([surface, { color, roughness, specular, depthBias, markings, patches, blobs, wet }]) => {
    const material = new MeshStandardMaterial({ color, roughness, fog: false, depthWrite: false });
    // Terrain haze; specular scaled (1 = three.js default) so a low sun glints instead of blowing out.
    material.onBeforeCompile = (shader) => {
      applyGroundHaze(shader);
      shader.uniforms.surfaceCenter = surfaceCenter;
      shader.uniforms.patchOffset = patchOffset;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vSurfaceXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurfaceXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      applyDepthBias(shader, depthBias, true);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vSurfaceXZ;\nuniform vec2 surfaceCenter;\nuniform vec2 patchOffset;')
        // Dissolve: dithered discard keeps the stripes opaque (no sorting, no blending).
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
          float surfaceFade = 1.0 - smoothstep(${(SURFACE_RADIUS_M - SURFACE_FADE_M).toFixed(1)}, ${SURFACE_RADIUS_M.toFixed(1)}, distance(vSurfaceXZ, surfaceCenter));
          if (surfaceFade < fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))) discard;`
        )
        .replace(
          '#include <lights_physical_fragment>',
          `#include <lights_physical_fragment>
          material.specularColorBlended *= mix(${specular.toFixed(2)}, ${WET_SPECULAR.toFixed(2)}, roadWetness);
          material.specularF90 *= mix(${specular.toFixed(2)}, ${WET_SPECULAR.toFixed(2)}, roadWetness);`
        );
      if (markings) applyMarkings(shader);
      applyPatches(shader, patches); // after: its code lands before the markings'
      applyBlobs(shader, blobs);
      applyWetness(shader, wet);
    };
    material.customProgramCacheKey = () => `roadSurface-${surface}`;
    return [surface, material];
  })
);

const f = (n) => n.toFixed(3);

/**
 * Brighter / darker patches from value noise on world x, z (needs vSurfaceXZ); octaves finer than a
 * couple of pixels fade to their mean, so far road doesn't shimmer.
 */
function applyPatches(shader, swing) {
  const octaves = PATCH_CELLS_M.map(
    (cell, i) => `{
        vec2 p = patchXZ / ${f(cell)};
        float weight = ${f(1 / 2 ** i)} * (1.0 - smoothstep(0.25, 0.5, length(fwidth(p))));
        patchShade += (surfacePatchNoise(p, ${f(PATCH_PERIOD_M / cell)}) - 0.5) * weight;
        total += ${f(1 / 2 ** i)};
      }`
  );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      float surfacePatchHash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      float surfacePatchNoise(vec2 p, float period) {
        vec2 i = floor(p);
        vec2 u = fract(p);
        u = u * u * (3.0 - 2.0 * u);
        vec2 j = mod(i + 1.0, period);
        i = mod(i, period);
        return mix(
          mix(surfacePatchHash(i), surfacePatchHash(vec2(j.x, i.y)), u.x),
          mix(surfacePatchHash(vec2(i.x, j.y)), surfacePatchHash(j), u.x),
          u.y
        );
      }`
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        vec2 patchXZ = vSurfaceXZ + patchOffset;
        float patchShade = 0.0;
        float total = 0.0;
        ${octaves.join('\n        ')}
        diffuseColor.rgb *= 1.0 + ${f(swing * 2)} * patchShade / total;
      }`
    );
}

/**
 * Polka dots: one dot per grid cell (2 diameters wide) at most, kept inside it, so one lookup per layer.
 * Layers whose dots are under a few pixels fade out, so far road doesn't shimmer.
 */
function applyBlobs(shader, layers = []) {
  if (!layers.length) return;
  const code = layers.map(({ diameterM, density, swing }, i) => {
    const cell = diameterM * 2;
    return `{
        vec2 p = patchXZ / ${f(cell)};
        vec2 id = mod(floor(p), ${f(Math.round(PATCH_PERIOD_M / cell))}) + ${f(i * 101.7)};
        vec3 h = surfaceBlobHash(id);
        vec3 k = surfaceBlobHash(id + 57.31);
        float r = 0.25 * mix(${f(BLOB_MIN_SCALE)}, 1.0, h.z);
        vec2 centre = r + (1.0 - 2.0 * r) * h.xy;
        float aa = length(fwidth(p));
        // Hard edge, anti-aliased over a pixel.
        float dotMask = 1.0 - smoothstep(r - aa, r + aa, length(fract(p) - centre));
        float fade = 1.0 - smoothstep(${f(1 / BLOB_FADE_PX[0])}, ${f(1 / BLOB_FADE_PX[1])}, aa);
        blobShade += dotMask * step(k.x, ${f(density)}) * sign(k.y - 0.5) * ${f(swing)} * fade;
      }`;
  });
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      vec3 surfaceBlobHash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
        p3 += dot(p3, p3.yxz + 33.33);
        return fract((p3.xxy + p3.yzz) * p3.zyx);
      }`
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        vec2 patchXZ = vSurfaceXZ + patchOffset;
        float blobShade = 0.0;
        ${code.join('\n        ')}
        diffuseColor.rgb *= max(0.0, 1.0 + blobShade);
      }`
    );
}

/**
 * Wet surface (needs applyPatches' noise and the haze colour as the sky): darker and smoother,
 * puddles near-mirror, plus a Fresnel sky reflection (no env map to reflect). Also the overcast spread.
 */
function applyWetness(shader, { darken, roughness, sheen }) {
  shader.uniforms.roadWetness = roadWetness;
  shader.uniforms.roadOvercast = roadOvercast;
  const fineCell = PUDDLE_CELLS_M[PUDDLE_CELLS_M.length - 1];
  const puddleOctaves = PUDDLE_CELLS_M.map((cell, i) => {
    const weight = i ? 0.3 : 0.7;
    return `{
          vec2 p = wetXZ / ${f(cell)};
          float fine = 1.0 - smoothstep(0.25, 0.5, length(fwidth(p)));
          puddleNoise += ${f(weight)} * mix(0.5, puddleFacetNoise(p, ${f(PATCH_PERIOD_M / cell)}), fine);
        }`;
  });
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float roadWetness;\nuniform float roadOvercast;')
    // Before main, so after applyPatches' surfacePatchHash.
    .replace(
      'void main() {',
      `// Corner hashes interpolated linearly over the cell's two triangles (split along x = y).
      float puddleFacetNoise(vec2 p, float period) {
        vec2 i = floor(p);
        vec2 u = fract(p);
        vec2 j = mod(i + 1.0, period);
        i = mod(i, period);
        float a = surfacePatchHash(i);
        float c = surfacePatchHash(j);
        if (u.x > u.y) {
          float b = surfacePatchHash(vec2(j.x, i.y));
          return a + (b - a) * u.x + (c - b) * u.y;
        }
        float d = surfacePatchHash(vec2(i.x, j.y));
        return a + (c - d) * u.x + (d - a) * u.y;
      }
      void main() {`
    )
    .replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      float wetPuddle = 0.0;
      if (roadWetness > ${f(PUDDLES_FROM)}) {
        vec2 wetXZ = vSurfaceXZ + patchOffset;
        float puddleNoise = 0.0;
        ${puddleOctaves.join('\n        ')}
        float level = smoothstep(${f(PUDDLES_FROM)}, 1.0, roadWetness);
        float edge = mix(${f(PUDDLE_THRESHOLD.from)}, ${f(PUDDLE_THRESHOLD.soaked)}, level);
        float aa = max(fwidth(puddleNoise), 1e-4);
        wetPuddle = level * smoothstep(edge - aa, edge + aa, puddleNoise);
        // Flat tint per fine triangle: faceted water.
        vec2 fp = wetXZ / ${f(fineCell)};
        float facet = surfacePatchHash(mod(floor(fp), ${f(PATCH_PERIOD_M / fineCell)}) + (fract(fp.x) > fract(fp.y) ? 0.37 : 0.0));
        diffuseColor.rgb *= 1.0 - ${f(PUDDLE_FACET_SHADE)} * facet * wetPuddle;
      }
      diffuseColor.rgb *= mix(1.0, ${f(darken)}, roadWetness) * (1.0 - 0.25 * wetPuddle);
      roughnessFactor = mix(roughnessFactor, ${f(roughness)}, roadWetness);
      roughnessFactor = mix(roughnessFactor, max(roughnessFactor, ${f(OVERCAST_ROUGHNESS)}), roadOvercast * (1.0 - ${f(OVERCAST_WET_HOLD)} * roadWetness));
      roughnessFactor = mix(roughnessFactor, 0.08, wetPuddle);`
    )
    .replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      {
        float wetFresnel = 0.02 + 0.98 * pow(1.0 - saturate(dot(geometryNormal, geometryViewDir)), 5.0);
        reflectedLight.indirectSpecular += hazeColor * wetFresnel * roadWetness * mix(${f(sheen)}, ${f(PUDDLE_SHEEN)}, wetPuddle);
      }`
    );
}

/** Paints the road markings from the stripe attributes (vectorLineLayer.js); lines widen to a pixel and fade, so they don't shimmer far off. */
function applyMarkings(shader) {
  shader.uniforms.markingColor = { value: MARKING.color };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 stripe;\nattribute float stripeMarkings;\nvarying vec4 vStripe;\nvarying float vStripeMarkings;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvStripe = stripe;\nvStripeMarkings = stripeMarkings;');
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      varying vec4 vStripe;
      varying float vStripeMarkings;
      uniform vec3 markingColor;
      float markingLine(float d, float halfWidth, float aa) {
        float w = max(halfWidth, aa);
        return (1.0 - smoothstep(w - aa, w + aa, d)) * (halfWidth / w);
      }`
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        float flags = floor(vStripeMarkings + 0.5);
        float across = abs(vStripe.x);
        float aa = fwidth(vStripe.x);
        float edges = mod(flags, 2.0);
        float centre = mod(floor(flags / 2.0), 2.0);
        float edgeOffset = vStripe.w - ${f(MARKING.edgeInset)};
        if (mod(floor(flags / 4.0), 2.0) > 0.5) edgeOffset = min(edgeOffset, ${f(MARKING.laneWidth)});
        if (flags >= 8.0) edgeOffset = min(edgeOffset, ${f(MARKING.laneWidth / 2)});
        float edge = edges * markingLine(abs(across - edgeOffset), ${f(MARKING.edgeWidth / 2)}, aa);
        float along = mod(vStripe.y, ${f(MARKING.period)});
        float aaAlong = fwidth(vStripe.y);
        float dash = smoothstep(0.0, aaAlong, along) * (1.0 - smoothstep(${f(MARKING.dash)}, ${f(MARKING.dash)} + aaAlong, along));
        dash = mix(dash, ${f(MARKING.dash / MARKING.period)}, clamp(aaAlong * ${f(2 / MARKING.period)}, 0.0, 1.0));
        float mid = centre * dash * markingLine(across, ${f(MARKING.centreWidth / 2)}, aa);
        float clear = smoothstep(${f(MARKING.junctionGap)}, ${f(MARKING.junctionGap + MARKING.junctionRamp)}, vStripe.z);
        diffuseColor.rgb = mix(diffuseColor.rgb, markingColor, max(edge, mid) * clear);
      }`
    );
}

/** Marking flags of a street style. */
function markingsOf(style) {
  if (style.key.endsWith('_construction')) return 0;
  const edges = EDGE_LINE_CLASSES.has(style.key) ? MARK_EDGES : 0;
  if (style.ramp) return edges | MARK_ONE_LANE;
  const twoLanes = TWO_LANE_CLASSES.has(style.key);
  return (
    edges |
    (CENTRE_LINE_CLASSES.has(style.key) && (twoLanes || !style.oneway) ? MARK_CENTRE : 0) |
    (twoLanes ? MARK_TWO_LANES : 0)
  );
}

// Debug road polygons: wireframe over the stripes; the fill is skipped when only the polygons are asked for.
const POLYGON_MATERIAL = new MeshBasicMaterial({ color: 0xffd400, wireframe: true, transparent: true, opacity: 0.8, fog: false });
const HIDDEN_MATERIAL = new MeshBasicMaterial({ visible: false });
const POLYGON_LIFT = 0.05;

// `${surface}:${width}:${markings}:${depthRank}` -> surface view style (buckets per surface; the rest per segment).
const surfaceStyles = new Map();

/** Surface view style of a street style; null off the road bed (tracks, paths, bridges, tunnels). */
function surfaceStyle(style) {
  if (!onRoadBed(style.key, style.brunnel)) return null;
  const surface = style.unpaved ? 'unpaved' : 'paved';
  const markings = SURFACE_LOOKS[surface].markings ? markingsOf(style) : undefined;
  const depthRank = depthRankOf(style.key);
  const key = `${surface}:${style.linewidth}:${markings}:${depthRank}`;
  let out = surfaceStyles.get(key);
  if (!out) {
    // Bucketed per rank: drawn in rank order, unpaved over paved within one, all below the contact shadows.
    const renderOrder = GROUND_RENDER_ORDER.roadSurface + (depthRank * 2 + (surface === 'unpaved' ? 1 : 0)) / (2 * BED_HIERARCHY.length);
    out = { key: `surface-${surface}-${depthRank}`, linewidth: style.linewidth, material: surfaceMaterials[surface], lift: SURFACE_LOOKS[surface].lift, lit: true, markings, depthRank, renderOrder };
    surfaceStyles.set(key, out);
  }
  return out;
}

/** Importance of a class key for line ends (vectorLineLayer `rank`): higher up ROAD_HIERARCHY = larger (aliases rank as their base class). */
function classRankOf(key) {
  const def = ROAD_CLASSES[key.replace(/_construction$/, '')];
  return ROAD_HIERARCHY.length - ROAD_HIERARCHY.findIndex((cls) => ROAD_CLASSES[cls] === def);
}

/** roadClasses {key, color, width, unpaved} -> vectorLineLayer {key, color, linewidth, rank}, plus brunnel for roadside.js and oneway / ramp for the markings. */
function classify(props) {
  const style = classifyRoad(props);
  if (!style) return null;
  return { key: style.key, color: style.color, linewidth: style.width, rank: classRankOf(style.key), unpaved: style.unpaved, brunnel: props.brunnel, oneway: !!Number(props.oneway), ramp: !!Number(props.ramp) };
}

const StreetLayer = createVectorLineLayer({
  tileZoom: STREET_TILE_ZOOM,
  layerName: 'transportation',
  classify,
  lift: STREET_LIFT,
  flat: true,
  alwaysStream: true,
  radius: DETAIL_BOX, // every DETAIL_ZOOM tile terrain streams (HIGH, MEDIUM and LOW)
});

/** Streams road centerlines (see header). */
export class StreetsManager extends StreetLayer {
  constructor(...args) {
    super(...args);
    this._debugShown = false;
    this._surfaceShown = false;
    this._polygonsShown = false;
    this._surfaceView = false; // meshes are built in the surface look
    this._look = '';
  }

  /** K-key debug overlay (class colours); wins over the surface view. */
  setVisible(visible) {
    this._debugShown = visible;
    this._applyView();
  }

  /** Settings road surface view: tarmac / unpaved stripes. */
  setSurfaceVisible(visible) {
    this._surfaceShown = visible;
    this._applyView();
  }

  shiftOrigin(lat, lon, dx, dz) {
    super.shiftOrigin(lat, lon, dx, dz);
    const o = patchOffset.value;
    o.set((o.x + dx) % PATCH_PERIOD_M, (o.y + dz) % PATCH_PERIOD_M);
  }

  /** Car position (world x, z) the surface view is drawn around. */
  setSurfaceCenter(x, z) {
    surfaceCenter.value.set(x, z);
  }

  _meshRadius() {
    if (!this._surfaceView) return this.radius;
    return Math.min(this.radius, Math.ceil(SURFACE_RADIUS_M / tileSizeMeters(DETAIL_ZOOM, this.originLat)));
  }

  /** Debug road polygons: wireframe of the stripes, in whichever look is built. */
  setPolygonsVisible(visible) {
    this._polygonsShown = visible;
    this._applyView();
  }

  get visible() {
    return this._debugShown;
  }

  /** Settings road surface view on (the streaming status names the builds after it). */
  get surfaceShown() {
    return this._surfaceShown;
  }

  pendingWork() {
    const work = super.pendingWork();
    // Surface stripes also wait on terrain tiles near the car.
    if (this._surfaceShown) work.builds += this._groundWaits;
    return work;
  }

  _applyView() {
    this._surfaceView = !this._debugShown && (this._surfaceShown || this._polygonsShown);
    const look = `${this._debugShown}/${this._surfaceShown}/${this._polygonsShown}`;
    if (look !== this._look) {
      this._look = look;
      super.setVisible(false); // drops the meshes, so they rebuild in the other look
    }
    super.setVisible(this._debugShown || this._surfaceShown || this._polygonsShown);
  }

  _makeMesh(bucket) {
    const mesh = super._makeMesh(bucket);
    if (this._surfaceView && !this._surfaceShown) mesh.material = HIDDEN_MATERIAL;
    if (this._polygonsShown) {
      const wire = new Mesh(mesh.geometry, POLYGON_MATERIAL);
      wire.position.y = POLYGON_LIFT; // the fill's depth bias would hide it otherwise
      mesh.add(wire);
    }
    return mesh;
  }

  _buildItem(seg, byStyleKey) {
    if (!this._surfaceView) return super._buildItem(seg, byStyleKey);
    const style = surfaceStyle(seg.style);
    if (style) super._buildItem({ ...seg, style }, byStyleKey);
  }

  /** 'road' if a paved stripe covers world (x, z), else 'unpaved' if an unpaved one does, else null. */
  surfaceAt(x, z) {
    let hit = null;
    for (const style of this.stylesAt(x, z)) {
      if (!style.unpaved) return 'road'; // paved wins where they overlap (junctions)
      hit = 'unpaved';
    }
    return hit;
  }
}
