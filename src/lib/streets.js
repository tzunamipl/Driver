// OSM roads as flat stripes coloured/sized by class (roadClasses.js),
// debug overlay on the K key. Always streams: surfaceAt() drives the
// road/unpaved tyre-grip surface (terrainSurface.js). Plumbing: vectorLineLayer.js.
// Settings road surface view: the same stripes, so exactly where the tyres feel
// tarmac, drawn as asphalt / gravel for the roads carved into a road bed, within
// SURFACE_RADIUS_M of the car. Stage surface sections (lib/rally/stageSurfaces.js) are extra stripes
// over all of them, first in surfaceAt().

import { BufferGeometry, Color, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, ShaderChunk, Vector2 } from 'three';
import { createVectorLineLayer } from './vectorLineLayer.js';
import { classifyRoad, ROAD_CLASSES, ROAD_HIERARCHY } from './roadClasses.js';
import { DETAIL_BOX, DETAIL_ZOOM, GROUND_RENDER_ORDER, applyGroundHaze } from './terrain.js';
import { onRoadBed } from './terrain/roadBed.js';
import { tileSizeMeters, lon2tileX, lat2tileY } from './geo.js';
import { tileKey } from './tiles/vectorTileLayer.js';
import { STAGE_SURFACES } from './rally/stageSurfaces.js';
import { getWetness, onWeatherChange } from './weather.js';
import { GLINT_GLSL, GLINT_SLOTS, GLINT_UNIFORMS } from './lampGlints.js';

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
// Gloss (dry): setts / grain / slick mark matte gaps and per-piece polish; gloss = what matte parts get
// (roughness, specular share). grain = gravel stones on a world grid (cellM, stone radius share range,
// how far a stone strays from its cell's centre (share of a cell, up to 1), colour swing, gap shade, polish swing,
// wetFade = gone by the wetness puddles start at); glitter = ice facets on a world grid that flash in the sun / lamps
// (cellM, facet radius share of a cell, tilt = facet normal swing, sharpness = highlight exponent, strength, gone by
// the wetness puddles start at); slick = wet glossy blotches on the puddle noise (how far below its threshold, roughness scale, darken).
// edge = ragged sides frayed up to depthM in; the stripe is drawn depthM wider than the road for it, so the
// mean edge stays where the tyres feel it.
// puddles: wet look overrides (wetness they start at, noise threshold from start to soaked, cell sizes).
const SURFACE_LOOKS = {
  paved: {
    color: 0x47484c, roughness: 0.78, specular: 0.35, lift: 0, depthBias: 0.12, markings: true, patches: 0.14,
    wet: { darken: 0.55, roughness: 0.42, sheen: 0.15 },
    blobs: [{ diameterM: 2.5, density: 0.35, swing: 0.2 }, { diameterM: 0.6, density: 0.5, swing: 0.08 }],
    grain: { cellM: 0.03, radius: [0.22, 0.42], jitter: 0.9, swing: 0.12, gapShade: 0.85, polishSwing: 0.25 },
    gloss: { roughness: 0.95, specular: 0.4 },
  },
  unpaved: {
    color: 0x9c8868, roughness: 0.9, specular: 0.15, lift: 0, depthBias: 0.13, patches: 0.8,
    wet: { darken: 0.6, roughness: 0.5, sheen: 0.06 },
    blobs: [{ diameterM: 3, density: 0.4, swing: 0.2 }, { diameterM: 0.2, density: 0.8, swing: 0.25 }],
    edge: { depthM: 0.4 },
    grain: { cellM: 0.06, radius: [0.22, 0.42], jitter: 0.9, swing: 0.18, gapShade: 0.75, polishSwing: 0.3 },
    gloss: { roughness: 1, specular: 0.3 },
  },
  // Stage sections only.
  cobblestone: {
    color: 0x6f6a62, roughness: 0.7, specular: 0.8, lift: 0, depthBias: 0.13, patches: 0.2,
    setts: { widthM: 0.33, lengthM: 0.48, joint: 0.036, swing: 0.16, jointShade: 0.55, polishSwing: 0.25, wetSwing: 0.5, jointSheen: 0.35 },
    gloss: { roughness: 1, specular: 0.15 },
    wet: { darken: 0.6, roughness: 0.35, sheen: 0.14 },
  },
  mud: {
    color: 0x4f3b26, roughness: 0.62, specular: 0.25, lift: 0, depthBias: 0.13, patches: 0.5,
    wet: { darken: 0.75, roughness: 0.38, sheen: 0.1 },
    edge: { depthM: 0.4 },
    puddles: { from: 0.2, threshold: { from: 0.66, soaked: 0.48 }, cellsM: [3, 0.75] },
    blobs: [{ diameterM: 0.35, density: 0.6, swing: 0.2 }],
    slick: { rim: 0.12, polish: 0.5, darken: 0.85 },
    grain: { cellM: 0.04, radius: [0.22, 0.42], jitter: 1.9, swing: 0.14, gapShade: 0.95, polishSwing: 0.05, wetFade: true },
    gloss: { roughness: 0.95, specular: 0.4 },
  },
  snow: {
    color: 0xdfe4ea, roughness: 0.9, specular: 20.0, lift: 0, depthBias: 0.13, patches: 0.12,
    wet: { darken: 0.82, roughness: 0.5, sheen: 0.06 },
    puddles: { from: 0.6, threshold: { from: 0.78, soaked: 0.66 }, cellsM: [3, 0.75] },
    blobs: [{ diameterM: 1.6, density: 0.4, swing: 0.06 }],
    edge: { depthM: 0.5 },
    glitter: { cellM: 0.2, radius: 0.002, tilt: 0.5, sharpness: 300, strength: 30 },
    gloss: { roughness: 1, specular: 0.5 },
  },
  ice: {
    color: 0x9fb8c8, roughness: 0.18, specular: 0.6, lift: 0, depthBias: 0.13, patches: 0.3,
    wet: { darken: 0.85, roughness: 0.92, sheen: 1.45 },
    blobs: [{ diameterM: 2, density: 0.45, swing: 0.12 }, { diameterM: 0.3, density: 0.5, swing: 0.08 }],
    edge: { depthM: 0.25 },
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

// Stage section ends fade into the road over this, with a blotchy edge; the tyres switch halfway.
const SECTION_FADE_M = 8;

/** Surface view material of a look; `sectionEnds`: stage section stripes, faded out towards their ends (stripe attribute's z). */
function createSurfaceMaterial(surface, { color, roughness, specular, depthBias, markings, patches, blobs, setts, grain, glitter, slick, gloss, edge, wet, puddles }, sectionEnds) {
  const material = new MeshStandardMaterial({ color, roughness, fog: false, depthWrite: false });
  // Terrain haze; specular scaled (1 = three.js default) so a low sun glints instead of blowing out.
  material.onBeforeCompile = (shader) => {
    applyGroundHaze(shader);
    shader.uniforms.surfaceCenter = surfaceCenter;
    shader.uniforms.patchOffset = patchOffset;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSurfaceXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurfaceXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    if (markings || setts || sectionEnds || edge) shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 stripe;');
    applyDepthBias(shader, depthBias, true);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSurfaceXZ;\nuniform vec2 surfaceCenter;\nuniform vec2 patchOffset;\nfloat surfaceMatte = 0.0;\nfloat surfacePolish = 1.0;\nfloat surfaceSheen = 1.0;')
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
    if (setts) applySetts(shader, setts);
    if (grain) applyGrain(shader, grain, puddles?.from ?? PUDDLES_FROM);
    if (glitter) applyGlitter(shader, glitter, puddles?.from ?? PUDDLES_FROM);
    if (slick) applySlick(shader, slick, puddles);
    if (sectionEnds) applySectionEnds(shader);
    if (edge) applyRaggedEdge(shader, edge);
    applyWetness(shader, wet, puddles);
    if (gloss) applyGloss(shader, gloss); // after: its roughness lands before the wet look's
    applyLampGlints(shader, wet); // after applyGlitter: the pools keep their snow sparkle
  };
  material.customProgramCacheKey = () => `roadSurface-${surface}${sectionEnds ? '-section' : ''}`;
  return material;
}

const surfaceMaterials = Object.fromEntries(Object.entries(SURFACE_LOOKS).map(([surface, look]) => [surface, createSurfaceMaterial(surface, look, false)]));
const sectionMaterials = Object.fromEntries(Object.entries(SURFACE_LOOKS).map(([surface, look]) => [surface, createSurfaceMaterial(surface, look, true)]));

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
 * Cobbles: staggered rows of setts across the stripe (its `stripe` attribute: across, along), each its
 * own shade, polish and wet sheen, dark matte joints; fades to their mean once a sett is a couple of pixels, so far road doesn't shimmer.
 */
function applySetts(shader, { widthM, lengthM, joint, swing, jointShade, polishSwing, wetSwing, jointSheen }) {
  const jointShare = (2 * joint) / widthM + (2 * joint) / lengthM;
  const mean = 1 - (1 - jointShade) * jointShare;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vSett;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSett = stripe.xy;');
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      varying vec2 vSett;
      float settHash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 19.19);
        return fract((p3.x + p3.y) * p3.z);
      }`
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        vec2 size = vec2(${f(widthM)}, ${f(lengthM)});
        vec2 q = vSett / size;
        q.x += 0.5 * mod(floor(q.y), 2.0);
        vec2 inCell = fract(q);
        vec2 edge = min(inCell, 1.0 - inCell) * size;
        float aa = max(fwidth(vSett.x), fwidth(vSett.y));
        float jointMask = 1.0 - smoothstep(${f(joint)}, ${f(joint)} + aa, min(edge.x, edge.y));
        float settShade = (1.0 + (settHash(floor(q)) - 0.5) * ${f(swing * 2)}) * mix(1.0, ${f(jointShade)}, jointMask);
        float settFar = smoothstep(1.0, 4.0, aa / ${f(Math.min(widthM, lengthM))});
        diffuseColor.rgb *= mix(settShade, ${f(mean)}, settFar);
        surfaceMatte = max(surfaceMatte, jointMask * (1.0 - settFar));
        surfacePolish *= mix(1.0 + (settHash(floor(q) + 17.3) - 0.5) * ${f(polishSwing * 2)}, 1.0, settFar);
        // Wet: each sett reflects the sky its own amount, joints less.
        surfaceSheen *= mix((1.0 + (settHash(floor(q) + 5.1) - 0.5) * ${f(wetSwing * 2)}) * mix(1.0, ${f(jointSheen)}, jointMask), 1.0, settFar);
      }`
    );
}

/**
 * Gravel: a stone per world grid cell (random size, strays up to `jitter` from the cell's centre, so the
 * 3x3 cells around are checked; the biggest cover wins), each its own shade and polish, darker matte gaps;
 * fades out once a cell is a few pixels.
 */
function applyGrain(shader, { cellM, radius: [rMin, rMax], jitter, swing, gapShade, polishSwing, wetFade }, wetFrom) {
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      vec3 grainHash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
        p3 += dot(p3, p3.yxz + 41.17);
        return fract((p3.xxy + p3.yzz) * p3.zyx);
      }`
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        vec2 p = (vSurfaceXZ + patchOffset) / ${f(cellM)};
        float aa = length(fwidth(p));
        float near = 1.0 - smoothstep(1.0, 4.0, aa);
        ${wetFade ? `near *= 1.0 - smoothstep(0.0, ${f(wetFrom)}, roadWetness);` : ''}
        float stone = 0.0;
        vec3 k = vec3(0.5);
        if (near > 0.0) {
          vec2 base = floor(p);
          for (int dx = -1; dx <= 1; dx++) {
            for (int dy = -1; dy <= 1; dy++) {
              vec2 cell = base + vec2(float(dx), float(dy));
              vec2 id = mod(cell, ${f(Math.round(PATCH_PERIOD_M / cellM))});
              vec3 h = grainHash(id);
              float r = mix(${f(rMin)}, ${f(rMax)}, h.z);
              vec2 centre = cell + 0.5 + (h.xy - 0.5) * ${f(jitter)};
              float cover = 1.0 - smoothstep(r - aa, r + aa, length(p - centre));
              if (cover > stone) {
                stone = cover;
                k = grainHash(id + 31.7);
              }
            }
          }
        }
        diffuseColor.rgb *= mix(1.0, mix(${f(gapShade)}, 1.0 + (k.x - 0.5) * ${f(swing * 2)}, stone), near);
        surfaceMatte = max(surfaceMatte, (1.0 - stone) * near);
        surfacePolish *= mix(1.0, 1.0 + (k.y - 0.5) * ${f(polishSwing * 2)}, stone * near);
      }`
    );
}

/**
 * Snow glitter: a small facet per world grid cell with its own tilted normal; it adds a sharp highlight
 * from every direct light (sun, moon, lamps, headlights; shadows included) when it mirrors one into the
 * camera, so it twinkles as the view moves. Fades out once a cell is about a pixel, and as the snow gets wet.
 */
function applyGlitter(shader, { cellM, radius, tilt, sharpness, strength }, wetFrom) {
  const glint = `RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );`;
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      float glitterMask = 0.0;
      vec2 glitterTilt = vec2(0.0);
      vec3 glitterHash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
        p3 += dot(p3, p3.yxz + 27.13);
        return fract((p3.xxy + p3.yzz) * p3.zyx);
      }`
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        vec2 p = (vSurfaceXZ + patchOffset) / ${f(cellM)};
        float aa = length(fwidth(p));
        float near = (1.0 - smoothstep(0.5, 1.5, aa)) * (1.0 - smoothstep(0.0, ${f(wetFrom)}, roadWetness));
        if (near > 0.0) {
          vec2 id = mod(floor(p), ${f(Math.round(PATCH_PERIOD_M / cellM))});
          vec3 h = glitterHash(id);
          vec2 centre = 0.5 + (h.xy - 0.5) * ${f(1 - 2 * radius)};
          glitterMask = (1.0 - smoothstep(${f(radius)} - aa, ${f(radius)} + aa, length(fract(p) - centre))) * near;
          glitterTilt = (glitterHash(id + 71.9).xy - 0.5) * ${f(tilt * 2)};
        }
      }`
    )
    .replace('#include <lights_fragment_begin>', ShaderChunk.lights_fragment_begin)
    .replaceAll(
      glint,
      `${glint}
      if (glitterMask > 0.0) {
        vec3 facetNormal = normalize(geometryNormal + mat3(viewMatrix) * vec3(glitterTilt.x, 0.0, glitterTilt.y));
        float mirror = saturate(dot(reflect(-directLight.direction, facetNormal), geometryViewDir));
        reflectedLight.directSpecular += directLight.color * (glitterMask * ${f(strength)} * pow(mirror, ${f(sharpness)}) * step(0.0, dot(geometryNormal, directLight.direction)));
      }`
    );
}

// Glints off the wet film: water (F0 0.02) this rough across, GLINT_STREAK times along the view
// (long reflections down a wet road); puddles sharper, barely stretched. Full film at the asphalt sheen.
const GLINT_FILM_ROUGHNESS = 0.28;
const GLINT_PUDDLE_ROUGHNESS = 0.08;
const GLINT_STREAK = 4;
const GLINT_FULL_SHEEN = 0.15;

/**
 * Lamp glints (lampGlints.js): one specular glint per lamp / emitter, while the local car's two pool
 * spotlights only light the road here, so a pair of lamps shows two glints, not three. Wet, they come
 * off the water film instead of the surface, by the look's wet sheen.
 */
function applyLampGlints(shader, { sheen }) {
  Object.assign(shader.uniforms, GLINT_UNIFORMS);
  const direct = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', ShaderChunk.lights_fragment_begin);
  const spot = shader.fragmentShader.indexOf('getSpotLightInfo(');
  const at = shader.fragmentShader.indexOf(direct, spot);
  shader.fragmentShader =
    shader.fragmentShader.slice(0, at) +
    `if (glintsOn > 0.5 && isCarPool(spotLight.position)) {
      ReflectedLight poolLit = ReflectedLight(vec3(0.0), vec3(0.0), vec3(0.0), vec3(0.0));
      RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, poolLit );
      reflectedLight.directDiffuse += poolLit.directDiffuse;
    } else ${direct}` +
    shader.fragmentShader.slice(at + direct.length);
  shader.fragmentShader = shader.fragmentShader
    .replace(
      'void main() {',
      `${GLINT_GLSL}
      bool isCarPool(vec3 viewPos) {
        return distance((viewMatrix * vec4(carPoolPos[0], 1.0)).xyz, viewPos) < 0.01
          || distance((viewMatrix * vec4(carPoolPos[1], 1.0)).xyz, viewPos) < 0.01;
      }
      // GGX stretched along t (the view across the surface) by stretch.
      vec3 wetFilmGlint(vec3 l, vec3 v, vec3 n, float rough, float stretch) {
        vec3 h = normalize(l + v);
        vec3 t = v - n * dot(n, v);
        t = dot(t, t) > 1e-6 ? normalize(t) : normalize(cross(n, vec3(1.0, 0.0, 0.0)));
        vec3 b = cross(n, t);
        float ab = pow2(rough);
        float at = ab * stretch;
        float x = dot(h, t) / at;
        float y = dot(h, b) / ab;
        float d = x * x + y * y + pow2(saturate(dot(n, h)));
        float D = RECIPROCAL_PI / (at * ab * d * d);
        float V = V_GGX_SmithCorrelated(sqrt(at * ab), saturate(dot(n, l)), saturate(dot(n, v)));
        return F_Schlick(vec3(0.02), 1.0, saturate(dot(v, h))) * (V * D);
      }
      void main() {`
    )
    .replace(
      '#include <lights_fragment_maps>',
      `float glintFilm = mix(roadWetness * min(1.0, ${f(sheen / GLINT_FULL_SHEEN)} * surfaceSheen), 1.0, wetPuddle);
      float glintRough = mix(${f(GLINT_FILM_ROUGHNESS)}, ${f(GLINT_PUDDLE_ROUGHNESS)}, wetPuddle);
      float glintStretch = mix(${f(GLINT_STREAK)}, 1.5, wetPuddle);
      for (int i = 0; i < ${GLINT_SLOTS}; i++) {
        if (glintsOn < 0.5) break;
        vec3 l;
        float e = glintIrradiance(i, geometryPosition, geometryNormal, l);
        if (e <= 0.0) continue;
        vec3 surface = BRDF_GGX(l, geometryViewDir, geometryNormal, material);
        vec3 film = glintFilm > 0.0 ? wetFilmGlint(l, geometryViewDir, geometryNormal, glintRough, glintStretch) : vec3(0.0);
        reflectedLight.directSpecular += glintColor[i] * e * mix(surface, film, glintFilm);
      }
      #include <lights_fragment_maps>`
    );
}

/**
 * Wet mud: glossy darker blotches on the puddle noise (applyWetness), `rim` below its threshold, so they
 * come first as it gets wet and the puddles then fill them; dry mud has one even gloss.
 */
function applySlick(shader, { rim, polish, darken }, { from = PUDDLES_FROM, threshold = PUDDLE_THRESHOLD, cellsM = PUDDLE_CELLS_M } = {}) {
  const octaves = cellsM.map((cell, i) => `${f(i ? 0.3 : 0.7)} * puddleFacetNoise(slickXZ / ${f(cell)}, ${f(PATCH_PERIOD_M / cell)})`);
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    `#include <color_fragment>
      if (roadWetness > 0.0) {
        vec2 slickXZ = vSurfaceXZ + patchOffset;
        float n = ${octaves.join(' + ')};
        float edge = mix(${f(threshold.from)}, ${f(threshold.soaked)}, smoothstep(${f(from)}, 1.0, roadWetness)) - ${f(rim)};
        float aa = max(fwidth(n), 1e-4);
        float slick = smoothstep(edge - aa, edge + aa, n) * smoothstep(0.0, ${f(from)}, roadWetness);
        diffuseColor.rgb *= mix(1.0, ${f(darken)}, slick);
        surfacePolish *= mix(1.0, ${f(polish)}, slick);
      }`
  );
}

/**
 * Dry gloss from the patterns' surfaceMatte (0 face .. 1 gap / joint) and surfacePolish (roughness scale):
 * matte parts take `roughness` and `specular` of the highlight.
 */
function applyGloss(shader, { roughness, specular }) {
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      roughnessFactor = mix(clamp(roughnessFactor * surfacePolish, 0.0, 1.0), ${f(roughness)}, surfaceMatte);`
    )
    .replace(
      '#include <lights_physical_fragment>',
      `#include <lights_physical_fragment>
      material.specularColorBlended *= mix(1.0, ${f(specular)}, surfaceMatte);
      material.specularF90 *= mix(1.0, ${f(specular)}, surfaceMatte);`
    );
}

/**
 * Stage section ends (needs applyPatches' noise; stripe z = metres to the nearer end): blotchy dithered
 * discard over SECTION_FADE_M, so the surface frays into the road instead of stopping at a line.
 */
function applySectionEnds(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vSectionEnd;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSectionEnd = stripe.z;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vSectionEnd;')
    .replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
      {
        vec2 endXZ = vSurfaceXZ + patchOffset;
        float endNoise = 0.6 * surfacePatchNoise(endXZ / 2.5, ${f(PATCH_PERIOD_M / 2.5)}) + 0.4 * surfacePatchNoise(endXZ / 0.5, ${f(PATCH_PERIOD_M / 0.5)});
        if (clamp(vSectionEnd / ${f(SECTION_FADE_M)}, 0.0, 1.0) < 0.1 + 0.8 * endNoise) discard;
      }`
    );
}

/**
 * Ragged sides (needs applyPatches' noise; stripe x = metres across, w = half width): blotchy discard up to
 * depthM in from the side, straightening out where the band is under a couple of pixels, so far edges don't shimmer.
 */
function applyRaggedEdge(shader, { depthM }) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vEdgeAcross;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdgeAcross = stripe.xw;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vEdgeAcross;')
    .replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
      {
        float fromSide = vEdgeAcross.y - abs(vEdgeAcross.x);
        if (fromSide < ${f(depthM)}) {
          vec2 edgeXZ = vSurfaceXZ + patchOffset;
          float n = 0.65 * surfacePatchNoise(edgeXZ / 1.2, ${f(PATCH_PERIOD_M / 1.2)}) + 0.35 * surfacePatchNoise(edgeXZ / 0.3, ${f(PATCH_PERIOD_M / 0.3)});
          n = mix(n, 0.5, smoothstep(${f(depthM * 0.25)}, ${f(depthM * 0.5)}, fwidth(fromSide)));
          if (fromSide < ${f(depthM)} * n) discard;
        }
      }`
    );
}

/**
 * Wet surface (needs applyPatches' noise and the haze colour as the sky): darker and smoother,
 * puddles near-mirror, plus a Fresnel sky reflection (no env map to reflect). Also the overcast spread.
 */
function applyWetness(shader, { darken, roughness, sheen }, { from = PUDDLES_FROM, threshold = PUDDLE_THRESHOLD, cellsM = PUDDLE_CELLS_M } = {}) {
  shader.uniforms.roadWetness = roadWetness;
  shader.uniforms.roadOvercast = roadOvercast;
  const fineCell = cellsM[cellsM.length - 1];
  const puddleOctaves = cellsM.map((cell, i) => {
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
      if (roadWetness > ${f(from)}) {
        vec2 wetXZ = vSurfaceXZ + patchOffset;
        float puddleNoise = 0.0;
        ${puddleOctaves.join('\n        ')}
        float level = smoothstep(${f(from)}, 1.0, roadWetness);
        float edge = mix(${f(threshold.from)}, ${f(threshold.soaked)}, level);
        float aa = max(fwidth(puddleNoise), 1e-4);
        wetPuddle = level * smoothstep(edge - aa, edge + aa, puddleNoise);
        // Flat tint per fine triangle: faceted water.
        vec2 fp = wetXZ / ${f(fineCell)};
        float facet = surfacePatchHash(mod(floor(fp), ${f(PATCH_PERIOD_M / fineCell)}) + (fract(fp.x) > fract(fp.y) ? 0.37 : 0.0));
        diffuseColor.rgb *= 1.0 - ${f(PUDDLE_FACET_SHADE)} * facet * wetPuddle;
      }
      diffuseColor.rgb *= mix(1.0, ${f(darken)}, roadWetness) * (1.0 - 0.25 * wetPuddle);
      // Pieces keep their polish (surfacePolish) wet; matte gaps stay duller.
      roughnessFactor = mix(roughnessFactor, clamp(${f(roughness)} * surfacePolish * (1.0 + 0.6 * surfaceMatte), 0.0, 1.0), roadWetness);
      roughnessFactor = mix(roughnessFactor, max(roughnessFactor, ${f(OVERCAST_ROUGHNESS)}), roadOvercast * (1.0 - ${f(OVERCAST_WET_HOLD)} * roadWetness));
      roughnessFactor = mix(roughnessFactor, 0.08, wetPuddle);`
    )
    .replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      {
        float wetFresnel = 0.02 + 0.98 * pow(1.0 - saturate(dot(geometryNormal, geometryViewDir)), 5.0);
        reflectedLight.indirectSpecular += hazeColor * wetFresnel * roadWetness * mix(${f(sheen)} * surfaceSheen, ${f(PUDDLE_SHEEN)}, wetPuddle);
      }`
    );
}

/** Paints the road markings from the stripe attributes (vectorLineLayer.js); lines widen to a pixel and fade, so they don't shimmer far off. */
function applyMarkings(shader) {
  shader.uniforms.markingColor = { value: MARKING.color };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float stripeMarkings;\nvarying vec4 vStripe;\nvarying float vStripeMarkings;')
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
  const look = SURFACE_LOOKS[surface];
  // Ragged edges need the stripe attribute too.
  const markings = look.markings ? markingsOf(style) : look.edge ? 0 : undefined;
  const depthRank = depthRankOf(style.key);
  const key = `${surface}:${style.linewidth}:${markings}:${depthRank}`;
  let out = surfaceStyles.get(key);
  if (!out) {
    // Bucketed per rank: drawn in rank order, unpaved over paved within one, all below the contact shadows.
    const renderOrder = GROUND_RENDER_ORDER.roadSurface + (depthRank * 2 + (surface === 'unpaved' ? 1 : 0)) / (2 * BED_HIERARCHY.length);
    const linewidth = style.linewidth + (look.edge?.depthM ?? 0);
    out = { key: `surface-${surface}-${depthRank}`, linewidth, material: surfaceMaterials[surface], lift: look.lift, lit: true, markings, depthRank, renderOrder };
    surfaceStyles.set(key, out);
  }
  return out;
}

// `${look}:${width}` -> { linewidth (the road's, for the tyres), section, draw (surface view style, drawn over every road) }.
const sectionStyles = new Map();
const SECTION_RENDER_ORDER = GROUND_RENDER_ORDER.roadSurface + 0.999;
const SECTION_SEGMENT_M = 4;
const METERS_PER_DEGREE = 111_320;

function sectionStyle(surface, width) {
  const look = STAGE_SURFACES[surface].look;
  const key = `${look}:${width}`;
  let out = sectionStyles.get(key);
  if (!out) {
    const { lift, edge } = SURFACE_LOOKS[look];
    const draw = {
      key: `section-${look}`,
      linewidth: width + (edge?.depthM ?? 0),
      material: sectionMaterials[look],
      lift,
      lit: true,
      markings: 0, // stripe attribute: the setts, the end fade and the ragged edges
      depthRank: BED_HIERARCHY.length - 1,
      renderOrder: SECTION_RENDER_ORDER,
    };
    out = { linewidth: width, section: true, draw };
    sectionStyles.set(key, out);
  }
  return out;
}

/** Stage sections -> detail tile key -> stripe items like the decoded ones (a/b lat/lon, line, index, dist, len), plus their tyre `compound`. */
function sectionItems(sections) {
  const byTile = new Map();
  for (const { surface, points } of sections) {
    const def = STAGE_SURFACES[surface];
    if (!def || !(points?.length >= 2)) continue;
    const line = [];
    let dist = 0;
    for (let p = 0; p + 1 < points.length; p++) {
      const [aLat, aLon, width] = points[p];
      const [bLat, bLon] = points[p + 1];
      const style = sectionStyle(surface, width);
      const length = Math.hypot((bLat - aLat) * METERS_PER_DEGREE, (bLon - aLon) * METERS_PER_DEGREE * Math.cos((aLat * Math.PI) / 180));
      const pieces = Math.max(1, Math.ceil(length / SECTION_SEGMENT_M));
      let prev = { lat: aLat, lon: aLon };
      for (let i = 1; i <= pieces; i++) {
        const t = i / pieces;
        const next = { lat: aLat + (bLat - aLat) * t, lon: aLon + (bLon - aLon) * t };
        const item = { a: prev, b: next, style, dist, len: length / pieces, line, index: line.length, compound: def.compound };
        line.push(item);
        const key = tileKey(Math.floor(lon2tileX((prev.lon + next.lon) / 2, DETAIL_ZOOM)), Math.floor(lat2tileY((prev.lat + next.lat) / 2, DETAIL_ZOOM)));
        if (!byTile.has(key)) byTile.set(key, []);
        byTile.get(key).push(item);
        dist += item.len;
        prev = next;
      }
    }
    // As junctions of no width at both ends: the stripe's clearance is then the distance to the nearer end.
    line.junctions = [0, 0, dist, 0];
    line.total = dist;
  }
  return byTile;
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
    // Kept apart from the OSM items: roadside kinds place their props along those.
    this._sectionsByTile = new Map();
  }

  /** Stage surface sections (lib/rally/stageSurfaces.js file format) in force; [] clears them. */
  setSurfaceSections(sections) {
    this._sectionsByTile = sectionItems(sections);
    if (!this._surfaceView) return;
    super.setVisible(false); // drops the meshes, so they rebuild with the sections
    super.setVisible(true);
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

  /** Compiles every surface look's shaders (plain + stage section) with `compileView` (sceneSetup.js), so the first stripe of a surface doesn't stall a frame. */
  warmUp(compileView) {
    const probe = new Group();
    const geometry = new BufferGeometry();
    for (const material of [...Object.values(surfaceMaterials), ...Object.values(sectionMaterials)]) probe.add(new Mesh(geometry, material));
    return compileView(probe).finally(() => geometry.dispose());
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

  _beginChunkBuild(tx, ty) {
    const build = super._beginChunkBuild(tx, ty);
    const sections = this._surfaceView && this._sectionsByTile.get(build.key);
    if (sections) build.list = build.list.concat(sections);
    return build;
  }

  _buildItem(seg, byStyleKey) {
    if (!this._surfaceView) return super._buildItem(seg, byStyleKey);
    if (seg.style.section) return super._buildItem({ ...seg, style: seg.style.draw }, byStyleKey);
    const style = surfaceStyle(seg.style);
    if (style) super._buildItem({ ...seg, style }, byStyleKey);
  }

  /** A stage section's surfaceCompounds.js key where one covers world (x, z), else 'road' if a paved stripe does, else 'unpaved' if an unpaved one does, else null. */
  surfaceAt(x, z) {
    for (const list of this._listsNear(x, z, this._sectionsByTile)) {
      for (const seg of list) {
        const mid = seg.dist + seg.len / 2;
        if (Math.min(mid, seg.line.total - mid) >= SECTION_FADE_M / 2 && this.segmentMargin(seg, x, z) >= 0) return seg.compound;
      }
    }
    let hit = null;
    for (const style of this.stylesAt(x, z)) {
      if (!style.unpaved) return 'road'; // paved wins where they overlap (junctions)
      hit = 'unpaved';
    }
    return hit;
  }
}
