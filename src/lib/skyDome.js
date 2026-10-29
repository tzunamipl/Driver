import * as THREE from 'three';

// Sky colour by view direction: the anti-sun side and the zenith cool, a glow on the
// horizon towards the sun. Shared with the ground haze (terrain.js) so far hills fade
// into the sky right behind them. daylight.js sets the colours each frame.
export const skyUniforms = {
  skyBase: { value: new THREE.Color(0x87ceeb) },
  skyAway: { value: new THREE.Color(0x87ceeb) },
  skyGlow: { value: new THREE.Color(0x87ceeb) },
  skySunDir: { value: new THREE.Vector3(0, 1, 0) },
};

export const SKY_GRADIENT_GLSL = `
uniform vec3 skyBase;
uniform vec3 skyAway;
uniform vec3 skyGlow;
uniform vec3 skySunDir;
vec3 skyGradient(vec3 dir) {
  float toSun = dot(dir, skySunDir);
  float up = clamp(dir.y, 0.0, 1.0);
  vec3 col = mix(skyAway, skyBase, smoothstep(-0.7, 0.9, toSun));
  col = mix(col, skyAway, up * 0.6);
  float glow = pow(max(toSun, 0.0), 3.0) * pow(1.0 - up, 4.0);
  return mix(col, skyGlow, glow);
}
`;

const DOME_DISTANCE_M = 1000; // only rotated with the view, so any distance inside near/far works

/** Camera-centred sky dome drawn behind everything; scene.background stays as the clear colour. */
export function createSkyDome(scene) {
  const material = new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position * ${DOME_DISTANCE_M.toFixed(1)}, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vDir;
      ${SKY_GRADIENT_GLSL}
      void main() {
        gl_FragColor = vec4(skyGradient(normalize(vDir)), 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
  dome.frustumCulled = false;
  dome.renderOrder = -100;
  scene.add(dome);
  return dome;
}
