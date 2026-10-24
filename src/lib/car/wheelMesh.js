// Wheel sizing and the low-poly tyre + rim mesh.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tyreOffsets } from './axles.js';
import { panoramaEnv, paintReflection } from '../vehicles/geometry/paint.js';

const DEFAULT_WHEEL_RADIUS = 0.4;
const TYRE_COLOR = new THREE.Color(0x1a1a1a);
const MUD_COLOR = new THREE.Color(0x6b4a2b);
// Dirt (0..1) at which the tread is fully brown; the sidewalls brown from there to fully caked.
const TREAD_BROWN_AT = 0.5;
// Wet rubber: a water film (clearcoat) reflecting the sky, smoother underneath.
const DRY_ROUGHNESS = 0.9;
const WET_ROUGHNESS = 0.5;
const WET_FILM_ROUGHNESS = 0.15;

/** Tyre outer radius (m) from rim size (in) + tyre width/profile, else descriptor.wheelRadius. */
export function wheelRadiusOf(d) {
  if (d.rimSize && d.tyre && d.profile) return d.rimSize * 2.54 / 200 + d.tyre / 1000 * d.profile / 100;
  return d.wheelRadius ?? DEFAULT_WHEEL_RADIUS;
}

const DEFAULT_SEGMENTS = 8;

/** Tyre (torus sidewalls + tread cylinder) and rim, added to `parent`; `segments` around (low-poly in game). */
export function buildWheelMesh({ rimSize, tyre, profile, rimColor }, parent, segments = DEFAULT_SEGMENTS) {
  const tyreWallScale = 0.3;
  const group = new THREE.Group();
  const rimDiameter = rimSize * 2.54 / 100;
  const tyreWidth = tyre / 1000;
  const rimWidth = tyreWidth * 0.95;
  const tyreHeight = tyreWidth * profile / 100;
  const wheelSize = rimDiameter / 2 + tyreHeight;

  const sidewall = (rotY) => {
    const g = new THREE.TorusGeometry(wheelSize - tyreHeight / 2, tyreHeight / 2, 4, segments);
    g.scale(1, 1, tyreWallScale);
    g.translate(0, 0, tyreWidth / 2);
    g.rotateY(rotY);
    return g;
  };
  const tyreGeo1 = sidewall(Math.PI / 2);
  const tyreGeo2 = sidewall(-Math.PI / 2);
  const treadGeo = new THREE.CylinderGeometry(wheelSize, wheelSize, tyreWidth, segments, 1, true);
  treadGeo.rotateZ(Math.PI / 2);

  // Tread and sidewalls apart, so dirt can brown them separately (setTyreDirt).
  // Physical with a zero-strength env map while dry, so wetness can add the gloss (setTyreWetness).
  const sideMat = new THREE.MeshPhysicalMaterial({
    color: TYRE_COLOR,
    roughness: DRY_ROUGHNESS,
    flatShading: true,
    side: THREE.DoubleSide,
    envMap: panoramaEnv(),
    envMapIntensity: 0,
    clearcoat: 0,
    clearcoatRoughness: WET_FILM_ROUGHNESS,
  });
  const treadMat = sideMat.clone();
  group.add(new THREE.Mesh(tyreGeo1, sideMat));
  group.add(new THREE.Mesh(tyreGeo2, sideMat));
  group.add(new THREE.Mesh(treadGeo, treadMat));

  const tire = new THREE.Mesh(mergeGeometries([tyreGeo1, tyreGeo2, treadGeo], true), [sideMat, sideMat, treadMat]);
  tire.castShadow = true;
  group.add(tire);

  const rimGeo = new THREE.CylinderGeometry(rimDiameter / 2, rimDiameter / 2, rimWidth, segments);
  rimGeo.rotateZ(Math.PI / 2);
  const rim = new THREE.Mesh(rimGeo, new THREE.MeshStandardMaterial({ color: rimColor, metalness: 0.8, roughness: 0.35, flatShading: true }));
  rim.castShadow = true;
  group.add(rim);

  group.userData.tyreMats = { side: [sideMat], tread: [treadMat] };
  parent.add(group);
  return group;
}

/** Browns a wheel set's tyres: the tread up to TREAD_BROWN_AT dirt, then the sidewalls. */
export function setTyreDirt(wheelSet, dirt) {
  const mats = wheelSet.userData.tyreMats;
  if (!mats || mats.dirt === dirt) return;
  mats.dirt = dirt;
  const tread = Math.min(1, dirt / TREAD_BROWN_AT);
  const side = Math.max(0, (dirt - TREAD_BROWN_AT) / (1 - TREAD_BROWN_AT));
  for (const m of mats.tread) m.color.lerpColors(TYRE_COLOR, MUD_COLOR, tread);
  for (const m of mats.side) m.color.lerpColors(TYRE_COLOR, MUD_COLOR, side);
}

/** Glosses a wheel set's tyres with wetness 0 dry .. 1 soaked; reflections follow the day/night strength. */
export function setTyreWetness(wheelSet, wetness) {
  const mats = wheelSet.userData.tyreMats;
  const reflection = wetness * paintReflection();
  if (!mats || (mats.wetness === wetness && mats.reflection === reflection)) return;
  mats.wetness = wetness;
  mats.reflection = reflection;
  const roughness = DRY_ROUGHNESS + (WET_ROUGHNESS - DRY_ROUGHNESS) * wetness;
  for (const list of [mats.tread, mats.side]) {
    for (const m of list) {
      m.clearcoat = wetness;
      m.roughness = roughness;
      m.envMapIntensity = reflection;
    }
  }
}

/** One wheel position's mesh: a single wheel, or twin tyres side by side for a dual set. */
export function buildWheelSet(descriptor, parent, dual = false) {
  const tyreWidth = (descriptor.tyre ?? 225) / 1000;
  const offsets = tyreOffsets(tyreWidth, dual);
  if (offsets.length === 1) return buildWheelMesh(descriptor, parent);
  const set = new THREE.Group();
  const tyreMats = { side: [], tread: [] };
  for (const x of offsets) {
    const wheel = buildWheelMesh(descriptor, set);
    wheel.position.x = x;
    tyreMats.side.push(...wheel.userData.tyreMats.side);
    tyreMats.tread.push(...wheel.userData.tyreMats.tread);
  }
  set.userData.tyreMats = tyreMats;
  parent.add(set);
  return set;
}
