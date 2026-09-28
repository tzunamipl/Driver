import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { createCar } from './lib/car.js';
import { TerrainManager } from './lib/terrain.js';

// Real-world spawn location (Wroclaw city center). The terrain streams in
// real aerial imagery + elevation around wherever the car currently is, so
// you can drive anywhere on Earth from here - it's just the starting point.
const ORIGIN_LAT = 51.1079;
const ORIGIN_LON = 17.0385;

// ---------- Renderer / Scene / Camera ----------
const app = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 150, 900);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.1,
  1500
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

// ---------- Physics world ----------
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.defaultContactMaterial.friction = 0.05;

// ---------- Real-world terrain (aerial imagery + elevation, streamed) ----------
const terrain = new TerrainManager(scene, world, ORIGIN_LAT, ORIGIN_LON);

const loadingEl = document.createElement('div');
loadingEl.textContent = 'Loading real-world terrain\u2026';
Object.assign(loadingEl.style, {
  position: 'fixed',
  inset: '0',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#87ceeb',
  color: '#1a1a1a',
  font: '600 20px system-ui, sans-serif',
  zIndex: '10',
});
document.body.appendChild(loadingEl);

// ---------- Car ----------
// Start a few meters back along -Z (opposite of the car's forward +Z),
// and rotate 180° so it faces the opposite direction on spawn. Y is a small
// drop height above the (roughly zeroed) terrain at the origin; gravity
// settles it onto the real ground once the chunk physics bodies are loaded.
const START_POS = new CANNON.Vec3(0, 3, -5);
const START_QUAT = new CANNON.Quaternion();
START_QUAT.setFromEuler(0, Math.PI, 0);
let vehicle, chassisMesh, syncMeshes, reset;

// ---------- Keyboard controls ----------
const keys = new Set();
window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));

const MAX_FORCE = 300;
const MAX_STEER = 0.5;
const BRAKE_FORCE = 40;

function updateControls() {
  if (!vehicle) return;
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
    reset(START_POS, START_QUAT);
  }
}

// ---------- Gauges (speedometer + compass) ----------
const speedoNeedle = document.getElementById('speedo-needle');
const speedoValue = document.getElementById('speedo-value');
const compassDial = document.getElementById('compass-dial');
const compassValue = document.getElementById('compass-value');

const MAX_GAUGE_SPEED = 180; // km/h at full needle deflection
const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const forwardVec = new THREE.Vector3();

function updateGauges() {
  if (!chassisMesh || !vehicle) return;

  // Speed: physics velocity magnitude (m/s) -> km/h.
  const v = vehicle.chassisBody.velocity;
  const speedKmh = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * 3.6;
  const clamped = Math.min(speedKmh, MAX_GAUGE_SPEED);
  // Needle sweeps -90deg (0 km/h) to +90deg (MAX_GAUGE_SPEED).
  const needleDeg = -90 + (clamped / MAX_GAUGE_SPEED) * 180;
  speedoNeedle.style.transform = `translate(-50%, -100%) rotate(${needleDeg}deg)`;
  speedoValue.textContent = Math.round(speedKmh);

  // Heading: project the chassis' local forward axis onto the world XZ plane.
  forwardVec.set(0, 0, 1).applyQuaternion(chassisMesh.quaternion);
  let headingDeg = THREE.MathUtils.radToDeg(Math.atan2(forwardVec.x, forwardVec.z));
  headingDeg = (headingDeg + 360) % 360;

  // Rotate the dial opposite the heading so the fixed top pointer always
  // shows the direction the car is currently facing.
  compassDial.style.transform = `rotate(${-headingDeg}deg)`;
  const pointIndex = Math.round(headingDeg / 45) % 8;
  compassValue.innerHTML = `${COMPASS_POINTS[pointIndex]} &mdash; ${Math.round(headingDeg)}&deg;`;
}

// ---------- Camera follow ----------
const cameraOffset = new THREE.Vector3(0, 30, -20);
const cameraLookOffset = new THREE.Vector3(0, 10.5, 10);
const tmpVec = new THREE.Vector3();

function updateCamera() {
  if (!chassisMesh) return;
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
  updateGauges();

  if (chassisMesh) {
    // Stream terrain chunks in/out as the car moves (cheap no-op if the
    // player is still inside the currently-loaded tile).
    terrain.update(chassisMesh.position.x, chassisMesh.position.z);
  }

  renderer.render(scene, camera);
}

// Load the initial terrain around the spawn point before starting the sim,
// so the car never falls through an unloaded world.
terrain.init().then(() => {
  loadingEl.remove();
  ({ vehicle, chassisMesh, syncMeshes, reset } = createCar(world, scene, START_POS, START_QUAT));
  animate();
});
