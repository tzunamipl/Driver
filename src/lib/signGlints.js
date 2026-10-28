// Road signs throw the local car's head lamps back (retroreflective faces, lampGlints.js), so lit ones
// glint on the wet road too: curve chevrons and direction boards, not the edge posts.

import * as THREE from 'three';
import { addGlintSource, glintCone, glintIrradianceAt, GLINT_UNIFORMS } from './lampGlints.js';
import { CURVE_SIGN_FACE } from './roadSigns.js';

const CONE = glintCone(1.2, 0.5, 2); // thrown back towards the road in front of the face
const DISTANCE_M = 40;
const RETURN = 2; // glint intensity per unit of head lamp irradiance on the face

/** @param {ReturnType<typeof import('./roadside.js').createRoadside>} roadside */
export function addSignGlints(roadside) {
  const heads = GLINT_UNIFORMS.glintPos.value;
  const lampColor = GLINT_UNIFORMS.glintColor.value[0];

  function addFace(add, position, yaw, color) {
    const aim = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
    const lit = glintIrradianceAt(0, position, aim) + glintIrradianceAt(1, position, aim);
    if (lit > 0) add(position, aim, CONE, DISTANCE_M, lit * RETURN, color.clone().multiply(lampColor));
  }

  return addGlintSource((add, x, z, rangeSq) => {
    if (heads[0].w <= 0 && heads[1].w <= 0) return;
    const near = (px, pz) => (px - x) ** 2 + (pz - z) ** 2 <= rangeSq;
    const { transforms } = roadside.standingTransforms('curveSigns');
    for (let i = 0; i < transforms.length; i += 4) {
      const [px, py, pz, yaw] = transforms.slice(i, i + 4);
      if (near(px, pz)) addFace(add, { x: px, y: py + CURVE_SIGN_FACE.y, z: pz }, yaw, CURVE_SIGN_FACE.color);
    }
    for (const { object } of roadside.standing('directionSigns')) {
      const { x: px, y: py, z: pz } = object.position;
      if (object.visible && near(px, pz)) addFace(add, { x: px, y: py + object.userData.glint.y, z: pz }, object.rotation.y, object.userData.glint.color);
    }
  });
}
