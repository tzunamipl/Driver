import * as THREE from 'three';

// Renderer / scene / camera / lighting bootstrap - the pure "rendering
// environment" concern, isolated from physics, gameplay, and UI so it can
// be tuned (fog, shadows, FOV...) independently of everything else.

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
  scene.background = new THREE.Color(0x87ceeb);
  // Exponential-squared fog: unlike a linear Fog with a hard far cutoff,
  // this fades gradually and asymptotically - near the car it's barely
  // noticeable (so nearby detail stays crisp), while it naturally swallows
  // the far-LOD terrain into the sky color by tens of km out, mimicking
  // real atmospheric haze instead of hard-clipping distant terrain out of
  // view entirely.
  scene.fog = new THREE.FogExp2(0x87ceeb, 0.00005);

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
