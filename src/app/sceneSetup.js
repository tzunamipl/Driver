import * as THREE from 'three';
import { FAR_BASE_COLOR, SKY_COLOR } from '../lib/terrain.js';

// Renderer / scene / camera / lighting bootstrap - the pure "rendering
// environment" concern, isolated from physics, gameplay, and UI so it can
// be tuned (fog, shadows, FOV...) independently of everything else.

// Fog is tinted to match the FAR backdrop tier's own low-detail terrain
// color (its lowland elevation-ramp stop, see terrain.js FAR_BASE_COLOR)
// rather than the LOW tier's debug HUD color, so fogged-out tiles visually
// fade/"fall into" the same tone the low-detail backdrop already uses.
const FOG_COLOR = FAR_BASE_COLOR;

/**
 * Builds the renderer, scene, and camera and mounts the renderer's canvas
 * into #app. Returns the trio plus a resize() hook to wire up externally.
 */
export function createSceneEnvironment() {
  const app = document.getElementById('app');

  // Logarithmic depth buffer: needed because the view now spans from ~0.1m
  // (car interior/wheels) out to the far-LOD terrain tier tens of km away
  // (see terrain.js FAR_RADIUS_METERS) - a standard depth buffer doesn't
  // have enough precision across that range and would z-fight badly at
  // distance.
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = SKY_COLOR.clone();
  // Linear (not exponential) fog: stays fully clear out to 10km - nearby
  // and most of the LOW detail tier reads crisp with no haze at all - then
  // fades LOW detail tiles out between 10km and 20km (LOW_DETAIL_RADIUS's
  // own max reach), fully dissolving them into the fog color by 20km. The
  // FAR backdrop tier beyond that opts out of fog entirely (see its
  // material's fog:false in terrain.js) so it keeps its own hand-tuned
  // elevation color ramp instead of flattening into the fog color. Fog
  // only affects rendered geometry, not the sky (scene.background above
  // stays plain sky blue, deliberately not fog-tinted).
  const FOG_NEAR_METERS = 6_000;
  const FOG_FAR_METERS = 13_000;
  scene.fog = new THREE.Fog(FOG_COLOR, FOG_NEAR_METERS, FOG_FAR_METERS);

  const camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.1,
    // Far plane must reach past the far-LOD terrain tier's radius (see
    // terrain.js FAR_RADIUS_METERS = 150km) or that whole tier gets
    // frustum-culled and is never rendered no matter how the fog is tuned.
    160_000
  );
  camera.position.set(0, 5, -8);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera };
}

/**
 * Adds ambient + directional (sun) lighting to the scene. The sun's
 * position/target get re-centered on the car every frame (see mainLoop.js)
 * so its shadow frustum keeps up as the car drives away from spawn.
 */
export function createLighting(scene) {
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  const SUN_OFFSET = new THREE.Vector3(50, 80, 30);
  sun.position.copy(SUN_OFFSET);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -100;
  sun.shadow.camera.right = 100;
  sun.shadow.camera.top = 100;
  sun.shadow.camera.bottom = -100;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 300;
  scene.add(sun);
  scene.add(sun.target);
  return { sun, SUN_OFFSET };
}
