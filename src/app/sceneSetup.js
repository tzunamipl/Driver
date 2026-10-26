import * as THREE from 'three';
import { SKY_COLOR } from '../lib/terrain.js';
import { createStars } from '../lib/stars.js';
import { REVERSED_DEPTH } from '../config.js';
import { createColorGrade } from './colorGrade.js';

// Renderer, scene, camera and lights.

const FOG_COLOR = new THREE.Color(0.22, 0.38, 0.42).getHex();
const MSAA_SAMPLES = 4; // the scene target's antialiasing (the canvas's own is off then)

/** True if WebGL2 here has EXT_clip_control, which a reversed depth buffer needs. */
function supportsReversedDepth() {
  const gl = document.createElement('canvas').getContext('webgl2');
  const supported = !!gl?.getExtension('EXT_clip_control');
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return supported;
}

/**
 * three's shadow lookup only rejects z > 1; reversed, ground past the shadow camera's far plane
 * lands at z < 0 and reads as shadowed (a dark box down-sun of the car).
 */
function patchShadowFarPlane() {
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  const test = 'inFrustum && shadowCoord.z <= 1.0';
  if (!chunk.includes(test)) return console.warn('shadowmap_pars_fragment changed: far-plane patch not applied');
  THREE.ShaderChunk.shadowmap_pars_fragment = chunk.replaceAll(test, 'inFrustum && shadowCoord.z >= 0.0 && shadowCoord.z <= 1.0');
}

/**
 * Scene -> multisampled target with a reversed float depth buffer -> canvas (colour graded on the way).
 * The canvas's own depth buffer is 24-bit fixed point, too coarse for the view's range even reversed.
 */
function createReversedDepthView(renderer) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    samples: MSAA_SAMPLES,
    colorSpace: THREE.SRGBColorSpace, // 8-bit sRGB storage: no banding in the darks
    depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.FloatType),
  });
  target.resolveDepthBuffer = false; // depth is only needed while drawing
  const grade = createColorGrade(target.texture);
  const blitScene = new THREE.Scene();
  const blit = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), grade.material);
  blit.frustumCulled = false;
  blitScene.add(blit);
  const blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return {
    grade,
    resize() {
      renderer.getDrawingBufferSize(size);
      target.setSize(size.x, size.y);
    },
    render(scene, camera) {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      grade.update();
      renderer.render(blitScene, blitCamera);
    },
  };
}

/**
 * Builds renderer/scene/camera, mounts the canvas in #app; returns them plus renderView() for the frame
 * and the colour grade (null without the reversed depth target: the canvas is drawn directly then).
 */
export function createSceneEnvironment() {
  const app = document.getElementById('app');

  // The view spans ~0.1 m to over 100 km. Reversed float depth covers that like log depth does,
  // but log depth writes gl_FragDepth in every shader, so the GPU can't skip hidden fragments early.
  const reversedDepth = REVERSED_DEPTH && supportsReversedDepth();
  if (reversedDepth) patchShadowFarPlane();
  const renderer = new THREE.WebGLRenderer(
    reversedDepth
      ? { antialias: false, depth: false, reversedDepthBuffer: true }
      : { antialias: true, logarithmicDepthBuffer: true }
  );
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = SKY_COLOR.clone();
  // Linear fog for non-terrain objects; terrain and sky opt out (terrain
  // has its own distance haze, see terrain.js).
  const FOG_NEAR_METERS = 6_000;
  const FOG_FAR_METERS = 13_000;
  scene.fog = new THREE.Fog(FOG_COLOR, FOG_NEAR_METERS, FOG_FAR_METERS);

  const camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.1,
    // Far plane must exceed FAR_RADIUS_METERS or distant terrain is culled.
    160_000
  );
  camera.position.set(0, 5, -8);

  const view = reversedDepth ? createReversedDepthView(renderer) : null;
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    view?.resize();
  });

  const renderView = view ? () => view.render(scene, camera) : () => renderer.render(scene, camera);
  return { renderer, scene, camera, renderView, colorGrade: view?.grade ?? null };
}

/** Ambient + one directional light (sun by day, moon by night); daylight.js drives them each frame. */
export function createLighting(scene) {
  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffffff, 3.2);
  sun.position.set(0, 7, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -25;
  sun.shadow.camera.right = 25;
  sun.shadow.camera.top = 25;
  sun.shadow.camera.bottom = -25;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 100;
  scene.add(sun);
  scene.add(sun.target);

  const sunDisc = new THREE.Mesh(
      new THREE.SphereGeometry(8000, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xffee88, fog: false, })
  );
  scene.add(sunDisc);

  const moonDisc = new THREE.Mesh(
      new THREE.SphereGeometry(5000, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xdde4f0, fog: false, })
  );
  scene.add(moonDisc);

  return { sun, ambient, sunDisc, moonDisc, stars: createStars(scene) };
}
