import * as THREE from 'three';
import { localSiderealRad } from './sunPosition.js';

// Night sky: the brightest stars, placed by real RA/Dec (J2000; precession
// since is ~0.4 deg) and rotated each frame by local sidereal time and
// latitude, so the sky matches the car's location.

const DEG = Math.PI / 180;
// Beyond terrain (FAR_RADIUS_METERS) and inside the camera far plane.
const SKY_RADIUS_M = 140_000;
// Sun elevation (deg) where stars start to appear / reach full brightness.
const FADE_START_DEG = -3;
const FADE_FULL_DEG = -12;

// Every star of magnitude 2.0 or brighter: [name, RA hours, Dec deg, visual magnitude, colour?]
const STARS = [
  ['Sirius', 6.7525, -16.716, -1.46, 0xe0e8ff],
  ['Canopus', 6.3992, -52.696, -0.74, 0xfff8f0],
  ['AlphaCen', 14.6601, -60.834, -0.27, 0xfff0c8],
  ['Arcturus', 14.261, 19.182, -0.05, 0xffc080],
  ['Vega', 18.6156, 38.784, 0.03, 0xdce6ff],
  ['Capella', 5.2782, 45.998, 0.08, 0xfff0c0],
  ['Rigel', 5.2423, -8.202, 0.13, 0xc8d8ff],
  ['Procyon', 7.655, 5.225, 0.34, 0xfff8e8],
  ['Betelgeuse', 5.9195, 7.407, 0.45, 0xffb070],
  ['Achernar', 1.6286, -57.237, 0.46, 0xc8d8ff],
  ['Hadar', 14.0637, -60.373, 0.61, 0xd0dcff],
  ['Altair', 19.8464, 8.868, 0.76],
  ['Acrux', 12.4433, -63.099, 0.76, 0xd0dcff],
  ['Aldebaran', 4.5987, 16.509, 0.85, 0xffa868],
  ['Spica', 13.4199, -11.161, 0.97, 0xc8d8ff],
  ['Antares', 16.4901, -26.432, 1.06, 0xff9060],
  ['Pollux', 7.7553, 28.026, 1.14, 0xffd090],
  ['Fomalhaut', 22.9608, -29.622, 1.16],
  ['Deneb', 20.6905, 45.28, 1.25],
  ['Mimosa', 12.7954, -59.689, 1.25, 0xd0dcff],
  ['Regulus', 10.1395, 11.967, 1.35, 0xdce6ff],
  ['Adhara', 6.9771, -28.972, 1.5],
  ['Castor', 7.5766, 31.888, 1.58],
  ['Shaula', 17.5601, -37.104, 1.62],
  ['Bellatrix', 5.4189, 6.35, 1.64, 0xd0dcff],
  ['Gacrux', 12.5194, -57.113, 1.64, 0xffa070],
  ['Elnath', 5.4382, 28.608, 1.65],
  ['Miaplacidus', 9.22, -69.717, 1.67],
  ['Alnilam', 5.6036, -1.202, 1.69],
  ['Alnair', 22.1372, -46.961, 1.74],
  ['Alnitak', 5.6793, -1.943, 1.77],
  ['Alioth', 12.9005, 55.96, 1.77],
  ['Dubhe', 11.0621, 61.751, 1.79, 0xffd8a0],
  ['Mirfak', 3.4054, 49.861, 1.79],
  ['Regor', 8.1589, -47.337, 1.83, 0xc8d8ff],
  ['Wezen', 7.1399, -26.393, 1.84],
  ['KausAustralis', 18.4029, -34.385, 1.85],
  ['Alkaid', 13.7923, 49.313, 1.86],
  ['Avior', 8.3752, -59.509, 1.86, 0xffc890],
  ['Sargas', 17.622, -42.998, 1.87],
  ['Menkalinan', 5.9921, 44.948, 1.9],
  ['Atria', 16.8111, -69.028, 1.91, 0xffb070],
  ['Alhena', 6.6285, 16.399, 1.93],
  ['Peacock', 20.4275, -56.735, 1.94, 0xc8d8ff],
  ['Alsephina', 8.7451, -54.708, 1.96],
  ['Polaris', 2.5303, 89.264, 1.98, 0xfff4d8],
  ['Mirzam', 6.3783, -17.956, 1.98],
  ['Hamal', 2.1196, 23.463, 2.0, 0xffc890],
  ['Alphard', 9.4598, -8.659, 2.0, 0xffb880],
];

// Fades to nothing below the horizon (terrain may not cover it) and with daylight.
const HORIZON_FADE_GLSL = /* glsl */ `
  float horizonFade() {
    vec3 dir = normalize(mat3(modelMatrix) * position);
    return smoothstep(-0.01, 0.06, dir.y);
  }
`;

const pointsVertex = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float size;
  attribute float brightness;
  attribute float phase;
  uniform float uTime;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vAlpha;
  ${HORIZON_FADE_GLSL}
  void main() {
    float twinkle = 0.9 + 0.1 * sin(uTime * (2.0 + phase) + phase * 6.2831);
    vColor = color;
    vAlpha = brightness * twinkle * horizonFade();
    gl_PointSize = size * uPixelRatio;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const pointsFragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform float uVisibility;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    #include <logdepthbuf_fragment>
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float disc = smoothstep(1.0, 0.0, r);
    gl_FragColor = vec4(vColor, vAlpha * uVisibility * sqrt(disc));
  }
`;

/** Equatorial unit vector: x towards the vernal equinox, z towards the north celestial pole. */
function equatorialVector(raHours, decDeg) {
  const ra = raHours * 15 * DEG;
  const dec = decDeg * DEG;
  return new THREE.Vector3(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec));
}

export function createStars(scene) {
  const positions = [];
  const colors = [];
  const sizes = [];
  const brightness = [];
  const phases = [];
  const color = new THREE.Color();
  for (const [, ra, dec, mag, hex = 0xf4f6ff] of STARS) {
    const v = equatorialVector(ra, dec);
    positions.push(v.x, v.y, v.z);
    color.setHex(hex);
    colors.push(color.r, color.g, color.b);
    sizes.push(THREE.MathUtils.clamp(4 - 0.8 * mag, 2, 5.2));
    brightness.push(THREE.MathUtils.clamp(1.35 - 0.12 * mag, 0.7, 1));
    phases.push(Math.random());
  }

  const pointGeometry = new THREE.BufferGeometry();
  pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  pointGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  pointGeometry.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));
  pointGeometry.setAttribute('brightness', new THREE.Float32BufferAttribute(brightness, 1));
  pointGeometry.setAttribute('phase', new THREE.Float32BufferAttribute(phases, 1));
  const visibility = { value: 0 };
  const time = { value: 0 };
  const points = new THREE.Points(
    pointGeometry,
    new THREE.ShaderMaterial({
      vertexShader: pointsVertex,
      fragmentShader: pointsFragment,
      uniforms: {
        uVisibility: visibility,
        uTime: time,
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );

  const sky = new THREE.Group();
  sky.matrixAutoUpdate = false;
  // Drawn before other transparents (clouds) so those blend over the stars.
  points.renderOrder = -1;
  points.frustumCulled = false;
  sky.add(points);
  scene.add(sky);

  const horizonFromEquatorial = new THREE.Matrix4();
  const spin = new THREE.Matrix4();
  const radius = new THREE.Vector3(SKY_RADIUS_M, SKY_RADIUS_M, SKY_RADIUS_M);

  /** Per frame: orient the sky for `timeMs` at lat/lon, centred on `position`, faded by sun elevation. */
  function update(timeMs, lat, lon, position, sunElevationDeg) {
    visibility.value = THREE.MathUtils.smoothstep(-sunElevationDeg, -FADE_START_DEG, -FADE_FULL_DEG);
    sky.visible = visibility.value > 0;
    if (!sky.visible) return;
    time.value = performance.now() / 1000;

    // Equatorial (hour-angle frame) -> world (x = east, y = up, z = south) at latitude lat.
    const sinLat = Math.sin(lat * DEG);
    const cosLat = Math.cos(lat * DEG);
    horizonFromEquatorial.set(
      0, 1, 0, 0,
      cosLat, 0, sinLat, 0,
      sinLat, 0, -cosLat, 0,
      0, 0, 0, 1
    );
    spin.makeRotationZ(-localSiderealRad(timeMs, lon));
    sky.matrix
      .makeTranslation(position.x, position.y, position.z)
      .scale(radius)
      .multiply(horizonFromEquatorial)
      .multiply(spin);
    sky.matrixWorldNeedsUpdate = true;
  }

  return { update };
}
