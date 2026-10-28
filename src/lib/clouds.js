// Sky by cloud preset (lib/weather.js CLOUD_PRESETS): sparse distant cumulus (heaped
// puffs), high feathered cirrus ovals, and for patchy / broken / overcast a grey deck overhead
// (holed by the dissolve below full cover) with low grey cumulus under it. Clouds dissolve in at the far horizon and out once left behind;
// on a preset change the surplus dissolves away and the new ones fill the whole sky.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FAR_RADIUS_METERS, applyFogVeil, applyGroundHaze } from './terrain.js';

// Clouds per layer, deck 0..1 and the cumulus style, per preset.
const PRESETS = {
  clear: { cumulus: 0, cirrus: 0, deck: 0 },
  fair: { cumulus: 12, cirrus: 4, deck: 0 },
  cumulus: { cumulus: 40, cirrus: 0, deck: 0 },
  cirrus: { cumulus: 0, cirrus: 28, deck: 0 },
  patchy: { cumulus: 24, cirrus: 0, deck: 0.45, cumulusStyle: 'low' },
  broken: { cumulus: 28, cirrus: 0, deck: 0.75, cumulusStyle: 'low' },
  overcast: { cumulus: 30, cirrus: 0, deck: 1, cumulusStyle: 'low' },
};
const CUMULUS_STYLES = {
  high: { minHeight: 3_000, maxHeight: 6_000, color: 0xc5d8f0 },
  low: { minHeight: 1_000, maxHeight: 1_800, color: 0x9aa3ad },
};

// Room for a full layer while the previous preset's clouds fade out.
const CUMULUS_POOL = 64;
const CIRRUS_POOL = 40;
// New clouds spawn only near the far edge, never in front of the player.
const SPAWN_RADIUS_MIN = FAR_RADIUS_METERS * 0.1;
const SPAWN_RADIUS_MAX = FAR_RADIUS_METERS * 0.98;
// Despawn radius, beyond the spawn ring so approached clouds aren't yanked.
const DESPAWN_RADIUS = FAR_RADIUS_METERS * 1.05;
const FADE_MS = 2_000;
// Seconds between spawns (they trickle in).
const SPAWN_INTERVAL_MIN_S = 3;
const SPAWN_INTERVAL_MAX_S = 7;
// Filling the sky after a preset change: spawns per frame.
const FILL_PER_FRAME = 2;
const MIN_CLOUD_SEPARATION_METERS = 7_000;
// Attempts per spawn to find a spot clear of other clouds.
const MAX_SPAWN_ATTEMPTS = 10;

const CIRRUS_MIN_HEIGHT = 8_000;
const CIRRUS_MAX_HEIGHT = 11_000;
const CIRRUS_COLOR = 0xf4f8ff;
// Cirrus oval semi-axes (long along x) and spacing between centres, so big blobs don't merge.
const CIRRUS_LENGTH_MIN = 20_000;
const CIRRUS_LENGTH_MAX = 40_000;
const CIRRUS_WIDTH_RATIO_MIN = 0.4;
const CIRRUS_WIDTH_RATIO_MAX = 0.55;
const CIRRUS_SEPARATION_METERS = 40_000;
// Never fully solid: the dissolve noise keeps fraying them into feathers.
const CIRRUS_MAX_DISSOLVE = 0.3;
// Finer than the cumulus noise; stretched with the oval it reads as streaks along it.
const CIRRUS_DISSOLVE_CELLS_PER_UNIT = 10;
// One heading for every cirrus, as if laid out by the same high wind.
const CIRRUS_HEADING = Math.random() * Math.PI * 2;
// Cirrus skip the ground haze (thin streaks vanish in it) and stay nearer, well above the horizon.
const CIRRUS_SPAWN_RADIUS_MAX = FAR_RADIUS_METERS * 0.5;
const DECK_HEIGHT_METERS = 2_600;
const DECK_COLOR = 0xb4bcc6;
const DECK_OPACITY = 0.97;
const DECK_FADE_S = 6;
// Deck cover at which it reaches full opacity: a partial deck is solid cloud with gaps, not a veil.
const DECK_SOLID_COVER = 0.3;

const CLOUD_SHAPE_VARIANTS = 6;
// Few segments + flat shading: chiselled facets like the trees.
const PUFF_GEOMETRY = new THREE.SphereGeometry(1, 7, 5);

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function addPuff(puffs, x, y, z, r) {
  addEllipsoid(puffs, x, y, z, r, r, r);
}

function addEllipsoid(puffs, x, y, z, sx, sy, sz) {
  puffs.push(PUFF_GEOMETRY.clone().scale(sx, sy, sz).translate(x, y, z));
}

/**
 * Cumulus in unit space: overlapping puffs heaped into a dome over a flat base
 * at y = 0, about 2 wide along x, 1.2 along z and 1 tall.
 */
function buildCumulusGeometry() {
  const puffs = [];
  const baseCount = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < baseCount; i++) {
    const x = -0.75 + (1.5 * i) / (baseCount - 1) + randomRange(-0.08, 0.08);
    addPuff(puffs, x, randomRange(0.15, 0.3), randomRange(-0.25, 0.25), randomRange(0.35, 0.5));
  }
  for (let i = 0; i < 3; i++) {
    addPuff(puffs, randomRange(-0.5, 0.5), randomRange(0.45, 0.6), randomRange(-0.2, 0.2), randomRange(0.3, 0.42));
  }
  addPuff(puffs, randomRange(-0.25, 0.25), randomRange(0.7, 0.8), randomRange(-0.1, 0.1), randomRange(0.25, 0.35));
  // Depth puffs so it isn't a flat wall from the side.
  addPuff(puffs, randomRange(-0.3, 0.3), 0.25, 0.4, randomRange(0.3, 0.4));
  addPuff(puffs, randomRange(-0.3, 0.3), 0.25, -0.4, randomRange(0.3, 0.4));

  const geometry = mergeGeometries(puffs, false);
  for (const puff of puffs) puff.dispose();
  // Flat underside, the cumulus signature.
  const pos = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < 0) {
      pos.setY(i, 0);
      normal.setXYZ(i, 0, -1, 0);
    }
  }
  return geometry;
}

/**
 * Cirrus in unit space: one paper-thin disc of radius 1, stretched into an oval by the mesh scale
 * and frayed by a capped dissolve. Normals all point up, so seen from below it takes the sunlit top's shade.
 */
function buildCirrusGeometry() {
  const geometry = new THREE.SphereGeometry(1, 24, 6).scale(1, 0.01, 1);
  const normal = geometry.attributes.normal;
  for (let i = 0; i < normal.count; i++) normal.setXYZ(i, 0, 1, 0);
  return geometry;
}

// Clouds come and go by dissolving: fragments above a noise threshold are discarded while
// `dissolve` (0..1, per material) is below 1, on top of the opacity fade.
const DISSOLVE_CELLS_PER_UNIT = 4; // cumulus / cirrus: noise cells per unit of cloud geometry
const DECK_DISSOLVE_CELL_METERS = 1_500;

/**
 * onBeforeCompile hook adding the dissolve. `world`: noise in world metres (the deck follows the car,
 * so its own space would slide), else in the cloud's unit geometry. Returns the `dissolve` uniform and
 * `offset` added to the noise input: a per-cloud seed, or for `world` the floating-origin shift in metres.
 */
function dissolveShading(material, { hazed = false, world = false, cellsPerUnit = DISSOLVE_CELLS_PER_UNIT } = {}) {
  const dissolve = { value: 1 };
  const offset = { value: new THREE.Vector3() };
  material.onBeforeCompile = (shader) => {
    if (hazed) applyGroundHaze(shader);
    else applyFogVeil(shader);
    shader.uniforms.dissolve = dissolve;
    shader.uniforms.dissolveOffset = offset;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDissolvePos;\nuniform vec3 dissolveOffset;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vDissolvePos = ${world
          ? `((modelMatrix * vec4(transformed, 1.0)).xyz + dissolveOffset) / ${DECK_DISSOLVE_CELL_METERS.toFixed(1)}`
          // Not seeded by the world position: that moves on every floating-origin shift.
          : `position * ${cellsPerUnit.toFixed(1)} + dissolveOffset`};`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vDissolvePos;
        uniform float dissolve;
        float dissolveHash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1) * 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float dissolveNoise(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(dissolveHash(i), dissolveHash(i + vec3(1, 0, 0)), f.x), mix(dissolveHash(i + vec3(0, 1, 0)), dissolveHash(i + vec3(1, 1, 0)), f.x), f.y),
            mix(mix(dissolveHash(i + vec3(0, 0, 1)), dissolveHash(i + vec3(1, 0, 1)), f.x), mix(dissolveHash(i + vec3(0, 1, 1)), dissolveHash(i + vec3(1, 1, 1)), f.x), f.y),
            f.z
          );
        }`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        if (dissolve < 1.0) {
          float dissolveN = dissolveNoise(vDissolvePos) * 0.65 + dissolveNoise(vDissolvePos * 2.7) * 0.35;
          // Value noise sits mostly in 0.2..0.8: map the progress onto that band.
          if (dissolveN > mix(0.2, 0.8, dissolve)) discard;
        }`
      );
  };
  // Same hook source for every variant: key the program by the variant.
  material.customProgramCacheKey = () => `cloud-dissolve-${hazed}-${world}-${cellsPerUnit}`;
  return { dissolve, offset };
}

const CUMULUS_GEOMETRIES = Array.from({ length: CLOUD_SHAPE_VARIANTS }, buildCumulusGeometry);
const CIRRUS_GEOMETRY = buildCirrusGeometry();

// Per-layer spawn: geometry, placement and look of one cloud in `slot`.
const LAYERS = {
  cumulus: {
    poolSize: CUMULUS_POOL,
    spawnRadiusMax: SPAWN_RADIUS_MAX,
    hazed: true,
    // Opaque: fades in and out by the dissolve alone.
    material: () => new THREE.MeshStandardMaterial({
      roughness: 1,
      metalness: 0,
      flatShading: true,
      // Beyond scene.fog's range; hazed like the terrain instead.
      fog: false,
    }),
    height: (style) => randomRange(CUMULUS_STYLES[style].minHeight, CUMULUS_STYLES[style].maxHeight),
    place(slot, style) {
      const size = randomRange(900, 2_200);
      // Broader than tall: spread the puffs out more than they stack up.
      const spread = randomRange(1.3, 1.7);
      slot.mesh.geometry = CUMULUS_GEOMETRIES[Math.floor(Math.random() * CUMULUS_GEOMETRIES.length)];
      slot.mesh.scale.set(size * spread, size * randomRange(0.7, 1.0), size * spread);
      slot.material.color.set(CUMULUS_STYLES[style].color);
    },
  },
  cirrus: {
    poolSize: CIRRUS_POOL,
    spawnRadiusMax: CIRRUS_SPAWN_RADIUS_MAX,
    minSeparation: CIRRUS_SEPARATION_METERS,
    maxDissolve: CIRRUS_MAX_DISSOLVE,
    dissolveCellsPerUnit: CIRRUS_DISSOLVE_CELLS_PER_UNIT,
    material: () => new THREE.MeshStandardMaterial({
      color: CIRRUS_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      fog: false,
    }),
    height: () => randomRange(CIRRUS_MIN_HEIGHT, CIRRUS_MAX_HEIGHT),
    place(slot) {
      const length = randomRange(CIRRUS_LENGTH_MIN, CIRRUS_LENGTH_MAX);
      slot.mesh.geometry = CIRRUS_GEOMETRY;
      slot.mesh.scale.set(length, length, length * randomRange(CIRRUS_WIDTH_RATIO_MIN, CIRRUS_WIDTH_RATIO_MAX));
      slot.mesh.rotation.y = CIRRUS_HEADING;
      slot.targetOpacity = randomRange(0.5, 0.8);
    },
  },
};

/**
 * Creates the sky's clouds. Call update() once per frame.
 * @param {THREE.Scene} scene
 * @param {{ onOvercast?: (share: number) => void }} [hooks] - deck cover 0..1, every frame (daylight dims the sun by it)
 */
export function createClouds(scene, { onOvercast } = {}) {
  const layers = Object.fromEntries(
    Object.entries(LAYERS).map(([name, def]) => {
      const pool = [];
      for (let i = 0; i < def.poolSize; i++) {
        // Own material per cloud for independent fading.
        const material = def.material();
        const { dissolve, offset: dissolveSeed } = dissolveShading(material, { hazed: def.hazed, cellsPerUnit: def.dissolveCellsPerUnit });
        const mesh = new THREE.Mesh(CUMULUS_GEOMETRIES[0], material);
        mesh.visible = false;
        scene.add(mesh);
        pool.push({ mesh, material, dissolve, dissolveSeed, maxDissolve: def.maxDissolve ?? 1, active: false, fadingOut: false, fade: 0, targetOpacity: 0, style: null });
      }
      return [name, { def, pool, target: 0, style: 'high', filling: false, spawnTimer: 0 }];
    })
  );

  const deckMaterial = new THREE.MeshStandardMaterial({
    color: DECK_COLOR,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
    fog: false,
  });
  const { dissolve: deckDissolve, offset: deckOrigin } = dissolveShading(deckMaterial, { hazed: true, world: true });
  // Faces down (lit by the ambient only, like a cloud base).
  const deck = new THREE.Mesh(new THREE.CircleGeometry(FAR_RADIUS_METERS, 48), deckMaterial);
  deck.rotation.x = Math.PI / 2;
  deck.visible = false;
  deck.renderOrder = 1; // after the cirrus, which it hides
  scene.add(deck);
  let deckTarget = 0;
  let deckCover = 0;

  function setFade(slot, fade) {
    slot.fade = fade;
    if (slot.material.transparent) slot.material.opacity = slot.targetOpacity * fade;
    slot.dissolve.value = fade * slot.maxDissolve;
  }

  /** True if (x, y, z) clears `minSeparation` from every active cloud in `pool`. */
  function isFarEnoughFromActiveClouds(pool, x, y, z, minSeparation) {
    for (const p of pool) {
      if (!p.active) continue;
      const dx = p.mesh.position.x - x;
      const dy = p.mesh.position.y - y;
      const dz = p.mesh.position.z - z;
      if (Math.hypot(dx, dy, dz) < minSeparation) return false;
    }
    return true;
  }

  function spawnCloud(layer, playerX, playerZ, playerY, { scattered } = {}) {
    const slot = layer.pool.find((p) => !p.active);
    if (!slot) return;

    // Skip this spawn if no clear spot is found.
    let x, y, z;
    let found = false;
    for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      // Filling scatters across the whole radius.
      const max = layer.def.spawnRadiusMax;
      const dist = scattered ? randomRange(SPAWN_RADIUS_MIN * 0.3, max) : randomRange(SPAWN_RADIUS_MIN, max);
      x = playerX + Math.cos(angle) * dist;
      z = playerZ + Math.sin(angle) * dist;
      y = playerY + layer.def.height(layer.style);
      if (isFarEnoughFromActiveClouds(layer.pool, x, y, z, layer.def.minSeparation ?? MIN_CLOUD_SEPARATION_METERS)) {
        found = true;
        break;
      }
    }
    if (!found) return;

    slot.mesh.rotation.y = Math.random() * Math.PI * 2;
    layer.def.place(slot, layer.style);
    slot.mesh.position.set(x, y, z);
    // So clouds sharing a shape dissolve differently.
    slot.dissolveSeed.value.set(Math.random(), Math.random(), Math.random()).multiplyScalar(1000);
    setFade(slot, 0);
    slot.mesh.visible = true;
    slot.active = true;
    slot.fadingOut = false;
    slot.style = layer.style;
  }

  /** Switches to a preset (lib/weather.js CLOUD_PRESETS): surplus and mismatched clouds fade out, the rest fill in. */
  function setPreset(name) {
    const preset = PRESETS[name] ?? PRESETS.fair;
    for (const [key, layer] of Object.entries(layers)) {
      layer.target = preset[key];
      layer.style = key === 'cumulus' ? preset.cumulusStyle ?? 'high' : null;
      layer.filling = true;
      let kept = 0;
      for (const p of layer.pool) {
        if (!p.active || p.fadingOut) continue;
        if (p.style !== layer.style || kept >= layer.target) p.fadingOut = true;
        else kept++;
      }
    }
    deckTarget = preset.deck;
  }

  /**
   * @param {number} dt - frame delta in seconds.
   * @param {number} playerX
   * @param {number} playerZ
   * @param {number} playerY - cloud heights are above this.
   */
  function update(dt, playerX, playerZ, playerY) {
    const fadeStep = (dt * 1000) / FADE_MS;
    for (const layer of Object.values(layers)) {
      let liveCount = 0;
      for (const p of layer.pool) {
        if (!p.active) continue;

        const dx = p.mesh.position.x - playerX;
        const dz = p.mesh.position.z - playerZ;
        if (Math.hypot(dx, dz) > DESPAWN_RADIUS) p.fadingOut = true;

        if (p.fadingOut) {
          setFade(p, p.fade - fadeStep);
          if (p.fade <= 0) {
            p.active = false;
            p.mesh.visible = false;
          }
          continue;
        }
        liveCount++;
        if (p.fade < 1) setFade(p, Math.min(1, p.fade + fadeStep));
      }

      if (layer.filling) {
        for (let i = 0; i < FILL_PER_FRAME && liveCount < layer.target; i++, liveCount++) {
          spawnCloud(layer, playerX, playerZ, playerY, { scattered: true });
        }
        if (liveCount >= layer.target) layer.filling = false;
        continue;
      }
      layer.spawnTimer -= dt;
      if (layer.spawnTimer <= 0 && liveCount < layer.target) {
        spawnCloud(layer, playerX, playerZ, playerY);
        layer.spawnTimer = randomRange(SPAWN_INTERVAL_MIN_S, SPAWN_INTERVAL_MAX_S);
      }
    }

    // Overcast deck follows the car.
    const step = dt / DECK_FADE_S;
    deckCover = THREE.MathUtils.clamp(deckCover + Math.sign(deckTarget - deckCover) * step, Math.min(deckCover, deckTarget), Math.max(deckCover, deckTarget));
    deckMaterial.opacity = Math.min(1, deckCover / DECK_SOLID_COVER) * DECK_OPACITY;
    deckDissolve.value = deckCover;
    deck.visible = deckCover > 0;
    deck.position.set(playerX, playerY + DECK_HEIGHT_METERS, playerZ);
    onOvercast?.(deckCover);
  }

  /** Floating origin: keeps the deck's world-space dissolve pattern in place. */
  function shiftOrigin(dx, dz) {
    deckOrigin.value.x += dx;
    deckOrigin.value.z += dz;
  }

  setPreset('cumulus');
  return { update, setPreset, shiftOrigin };
}
