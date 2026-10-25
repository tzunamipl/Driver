// OSM roads as flat stripes coloured/sized by class (roadClasses.js),
// debug overlay on the K key. Always streams: surfaceAt() drives the
// road/unpaved tyre-grip surface (terrainSurface.js). Plumbing: vectorLineLayer.js.
// Settings road surface view: the same stripes, so exactly where the tyres feel
// tarmac, drawn as asphalt / gravel for the roads carved into a road bed, within
// SURFACE_RADIUS_M of the car.

import { Color, Mesh, MeshBasicMaterial, MeshStandardMaterial, Vector2 } from 'three';
import { createVectorLineLayer } from './vectorLineLayer.js';
import { classifyRoad } from './roadClasses.js';
import { DETAIL_BOX, DETAIL_ZOOM, applyGroundHaze } from './terrain.js';
import { onRoadBed } from './terrain/roadBed.js';
import { tileSizeMeters } from './geo.js';

// The transportation layer's maxzoom.
const STREET_TILE_ZOOM = 14;

// Lift above ground, against z-fighting.
const STREET_LIFT = 0.2;

// Surface view: low over the road bed (polygon offset does the rest); paved above unpaved where they meet.
// Surface view only around the car, dissolving out over the last FADE metres.
const SURFACE_RADIUS_M = 400;
const SURFACE_FADE_M = 100;
const surfaceCenter = { value: new Vector2() };

// Road markings on asphalt (flag bits in the style's `markings`): solid edge lines on the
// higher classes, a dashed centre line on most two-way roads; faded out at junctions.
const MARK_EDGES = 1;
const MARK_CENTRE = 2;
const EDGE_LINE_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary']);
const CENTRE_LINE_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']);
const MARKING = {
  color: new Color(0xe6e6df),
  edgeWidth: 0.15,
  edgeInset: 0.5, // edge line centre in from the stripe's side (the widths include a shoulder)
  centreWidth: 0.12,
  dash: 3, // centre line: painted metres per period
  period: 9,
  junctionGap: 1, // clear of a junction's widest road by this, then
  junctionRamp: 3, // fading in over this
};

// Asphalt keeps a sheen for the sun, moon and lamps; gravel is near matte.
const SURFACE_LOOKS = {
  paved: { color: 0x47484c, roughness: 0.65, specular: 0.35, lift: 0.07, offset: -0.1, markings: true },
  unpaved: { color: 0x9c8868, roughness: 0.9, specular: 0.15, lift: 0.05, offset: -1 },
};

const surfaceMaterials = Object.fromEntries(
  Object.entries(SURFACE_LOOKS).map(([surface, { color, roughness, specular, offset, markings }]) => {
    const material = new MeshStandardMaterial({ color, roughness, fog: false, polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset });
    // Terrain haze; specular scaled (1 = three.js default) so a low sun glints instead of blowing out.
    material.onBeforeCompile = (shader) => {
      applyGroundHaze(shader);
      shader.uniforms.surfaceCenter = surfaceCenter;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vSurfaceXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurfaceXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vSurfaceXZ;\nuniform vec2 surfaceCenter;')
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
          material.specularColorBlended *= ${specular.toFixed(2)};
          material.specularF90 *= ${specular.toFixed(2)};`
        );
      if (markings) applyMarkings(shader);
    };
    material.customProgramCacheKey = () => `roadSurface-${surface}`;
    return [surface, material];
  })
);

const f = (n) => n.toFixed(3);

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
        float centre = step(2.0, flags);
        float edge = edges * markingLine(abs(across - (vStripe.w - ${f(MARKING.edgeInset)})), ${f(MARKING.edgeWidth / 2)}, aa);
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
  return (EDGE_LINE_CLASSES.has(style.key) ? MARK_EDGES : 0) | (CENTRE_LINE_CLASSES.has(style.key) && !style.oneway ? MARK_CENTRE : 0);
}

// Debug road polygons: wireframe over the stripes; the fill is skipped when only the polygons are asked for.
const POLYGON_MATERIAL = new MeshBasicMaterial({ color: 0xffd400, wireframe: true, transparent: true, opacity: 0.8, fog: false });
const HIDDEN_MATERIAL = new MeshBasicMaterial({ visible: false });
const POLYGON_LIFT = 0.05;

// `${surface}:${width}:${markings}` -> surface view style (buckets per surface, width and markings per segment).
const surfaceStyles = new Map();

/** Surface view style of a street style; null off the road bed (tracks, paths, bridges, tunnels). */
function surfaceStyle(style) {
  if (!onRoadBed(style.key, style.brunnel)) return null;
  const surface = style.unpaved ? 'unpaved' : 'paved';
  const markings = SURFACE_LOOKS[surface].markings ? markingsOf(style) : undefined;
  const key = `${surface}:${style.linewidth}:${markings}`;
  let out = surfaceStyles.get(key);
  if (!out) {
    out = { key: `surface-${surface}`, linewidth: style.linewidth, material: surfaceMaterials[surface], lift: SURFACE_LOOKS[surface].lift, lit: true, markings };
    surfaceStyles.set(key, out);
  }
  return out;
}

/** roadClasses {key, color, width, unpaved} -> vectorLineLayer {key, color, linewidth}, plus brunnel for roadside.js and oneway for the markings. */
function classify(props) {
  const style = classifyRoad(props);
  if (!style) return null;
  return { key: style.key, color: style.color, linewidth: style.width, unpaved: style.unpaved, brunnel: props.brunnel, oneway: !!Number(props.oneway) };
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
      wire.position.y = POLYGON_LIFT; // the fill's polygon offset would hide it otherwise
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
