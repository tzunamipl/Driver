// Wheel sizing and the low-poly tyre + rim mesh.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tyreOffsets } from './axles.js';

const DEFAULT_WHEEL_RADIUS = 0.4;

/** Tyre outer radius (m) from rim size (in) + tyre width/profile, else descriptor.wheelRadius. */
export function wheelRadiusOf(d) {
  if (d.rimSize && d.tyre && d.profile) return d.rimSize * 2.54 / 200 + d.tyre / 1000 * d.profile / 100;
  return d.wheelRadius ?? DEFAULT_WHEEL_RADIUS;
}

/** Tyre (torus sidewalls + tread cylinder) and rim, added to `parent`. */
export function buildWheelMesh({ rimSize, tyre, profile, rimColor }, parent) {
  const segments = 8;
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

  const tireMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9, flatShading: true, side: THREE.DoubleSide });
  group.add(new THREE.Mesh(tyreGeo1, tireMat));
  group.add(new THREE.Mesh(tyreGeo2, tireMat));
  group.add(new THREE.Mesh(treadGeo, tireMat));

  const tire = new THREE.Mesh(
    mergeGeometries([tyreGeo1, tyreGeo2, treadGeo]),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9, flatShading: true })
  );
  tire.castShadow = true;
  group.add(tire);

  const rimGeo = new THREE.CylinderGeometry(rimDiameter / 2, rimDiameter / 2, rimWidth, segments);
  rimGeo.rotateZ(Math.PI / 2);
  const rim = new THREE.Mesh(rimGeo, new THREE.MeshStandardMaterial({ color: rimColor, metalness: 0.8, roughness: 0.35, flatShading: true }));
  rim.castShadow = true;
  group.add(rim);

  parent.add(group);
  return group;
}

/** One wheel position's mesh: a single wheel, or twin tyres side by side for a dual set. */
export function buildWheelSet(descriptor, parent, dual = false) {
  const tyreWidth = (descriptor.tyre ?? 225) / 1000;
  const offsets = tyreOffsets(tyreWidth, dual);
  if (offsets.length === 1) return buildWheelMesh(descriptor, parent);
  const set = new THREE.Group();
  for (const x of offsets) buildWheelMesh(descriptor, set).position.x = x;
  parent.add(set);
  return set;
}
