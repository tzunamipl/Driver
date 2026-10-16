import * as THREE from 'three';
import { SKY_COLOR } from '../lib/terrain.js';
import { createStars } from '../lib/stars.js';

// Renderer, scene, camera and lights.

const FOG_COLOR = new THREE.Color(0.22, 0.38, 0.42).getHex();

/** Builds renderer/scene/camera, mounts the canvas in #app; returns them plus resize(). */
export function createSceneEnvironment() {
  const app = document.getElementById('app');

  // Logarithmic depth: the view spans ~0.1 m to over 100 km.
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
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

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera };
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
