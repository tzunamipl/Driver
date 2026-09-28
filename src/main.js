import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { createPlaceholderMapTexture } from './lib/mapTexture.js';
import { createCar } from './lib/car.js';

// ---------- Renderer / Scene / Camera ----------
const app = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 60, 220);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.1,
  500
);
camera.position.set(0, 5, -8);

// ---------- Lighting ----------
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(50, 80, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -100;
sun.shadow.camera.right = 100;
sun.shadow.camera.top = 100;
sun.shadow.camera.bottom = -100;
scene.add(sun);

// ---------- Ground ("map" photo) ----------
const mapTexture = createPlaceholderMapTexture();
mapTexture.repeat.set(1, 1);

const groundSize = 200;
const groundMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(groundSize, groundSize),
  new THREE.MeshStandardMaterial({ map: mapTexture })
);
groundMesh.rotation.x = -Math.PI / 2;
groundMesh.receiveShadow = true;
scene.add(groundMesh);

// ---------- 3D detail props (solid placeholders) ----------
const propMaterial = new THREE.MeshStandardMaterial({ color: 0x888888 });
const props = [];
const propLayout = [
  [15, 1, 15],
  [-20, 1.5, 25],
  [30, 1, -18],
  [-15, 2, -30],
  [40, 1, 10],
];
propLayout.forEach(([x, h, z]) => {
  const size = 2 + Math.random() * 2;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, h * 2, size), propMaterial);
  mesh.position.set(x, h, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  props.push(mesh);
});

// ---------- Physics world ----------
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.defaultContactMaterial.friction = 0.3;

const groundBody = new CANNON.Body({
  mass: 0,
  shape: new CANNON.Plane(),
});
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(groundBody);

// static physics boxes matching the visual props
propLayout.forEach(([x, h, z], i) => {
  const size = props[i].geometry.parameters.width;
  const body = new CANNON.Body({ mass: 0 });
  body.addShape(new CANNON.Box(new CANNON.Vec3(size / 2, h, size / 2)));
  body.position.set(x, h, z);
  world.addBody(body);
});

// ---------- Car ----------
const START_POS = new CANNON.Vec3(0, 1, 0);
const { vehicle, chassisMesh, syncMeshes, reset } = createCar(world, scene, START_POS);

// ---------- Keyboard controls ----------
const keys = new Set();
window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));

const MAX_FORCE = 900;
const MAX_STEER = 0.5;
const BRAKE_FORCE = 40;

function updateControls() {
  const forward = keys.has('KeyW') || keys.has('ArrowUp');
  const backward = keys.has('KeyS') || keys.has('ArrowDown');
  const left = keys.has('KeyA') || keys.has('ArrowLeft');
  const right = keys.has('KeyD') || keys.has('ArrowRight');
  const handbrake = keys.has('Space');

  const engineForce = forward ? -MAX_FORCE : backward ? MAX_FORCE : 0;
  // rear-wheel drive (indices 2, 3)
  vehicle.applyEngineForce(engineForce, 2);
  vehicle.applyEngineForce(engineForce, 3);

  const steerValue = left ? MAX_STEER : right ? -MAX_STEER : 0;
  vehicle.setSteeringValue(steerValue, 0);
  vehicle.setSteeringValue(steerValue, 1);

  const brakeForce = handbrake ? BRAKE_FORCE : 0;
  for (let i = 0; i < 4; i++) vehicle.setBrake(brakeForce, i);

  if (keys.has('KeyR')) {
    reset(START_POS);
  }
}

// ---------- Camera follow ----------
const cameraOffset = new THREE.Vector3(0, 4, -8);
const cameraLookOffset = new THREE.Vector3(0, 1, 3);
const tmpVec = new THREE.Vector3();

function updateCamera() {
  const carPos = chassisMesh.position;
  const carQuat = chassisMesh.quaternion;

  tmpVec.copy(cameraOffset).applyQuaternion(carQuat).add(carPos);
  camera.position.lerp(tmpVec, 0.1);

  const lookAt = cameraLookOffset.clone().applyQuaternion(carQuat).add(carPos);
  camera.lookAt(lookAt);
}

// ---------- Resize ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Main loop ----------
const FIXED_STEP = 1 / 60;
let lastTime = performance.now();

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const delta = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  updateControls();
  world.step(FIXED_STEP, delta, 5);
  syncMeshes();
  updateCamera();

  renderer.render(scene, camera);
}

animate();
