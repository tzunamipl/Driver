import * as THREE from 'three';
import * as CANNON from 'cannon-es';

/**
 * Slants the top-front and top-back vertices of a BoxGeometry inward along Z
 * to create a tapered "greenhouse" shape (windshield/rear-window rake),
 * keeping everything low-poly (still just box triangles, no extra geometry).
 */
function taperCabinTop(geometry, frontInset, backInset) {
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (y > 0) {
      if (z > 0) pos.setZ(i, z - frontInset);
      else pos.setZ(i, z + backInset);
    }
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Builds a low-poly Subaru Impreza GC (90s WRX/STI rally-styled) body out of
 * primitive boxes/cylinders: boxy sedan shell, raked cabin greenhouse, hood
 * scoop, round rally fog lights + rectangular headlights, and the iconic
 * STI rear wing on struts. Returned as a THREE.Group standing in for the
 * chassis mesh, sized to roughly match the physics chassis footprint.
 */
function buildImprezaBody(chassisWidth, chassisLength) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1c3f94, metalness: 0.4, roughness: 0.45 }); // WRC blue
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x161616, metalness: 0.2, roughness: 0.8 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x141a20, metalness: 0.6, roughness: 0.15 });
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff3cf, emissive: 0x554417, roughness: 0.3 });
  const fogMat = new THREE.MeshStandardMaterial({ color: 0xffe28a, emissive: 0x7a5410, roughness: 0.3 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x7a0f0f, emissive: 0x3a0000, roughness: 0.4 });

  const parts = [];
  const add = (geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parts.push(mesh);
    return mesh;
  };

  // Main lower body shell.
  add(new THREE.BoxGeometry(chassisWidth, 0.5, chassisLength * 0.9), bodyMat, 0, -0.3, 0);

  // Tapered cabin/greenhouse (windshield rake at front, rear-window rake at back).
  const cabinGeo = taperCabinTop(new THREE.BoxGeometry(chassisWidth * 0.83, 0.55, chassisLength * 0.5), 0.5, 0.35);
  add(cabinGeo, glassMat, 0, 0.175, -0.1);

  // Hood (protrudes slightly past the main shell toward the nose).
  add(new THREE.BoxGeometry(chassisWidth * 0.97, 0.12, chassisLength * 0.28), bodyMat, 0, 0.01, chassisLength * 0.36);

  // Front bumper/nose cap.
  add(new THREE.BoxGeometry(chassisWidth, 0.35, 0.25), trimMat, 0, -0.35, chassisLength * 0.475);

  // Rear trunk deck + bumper.
  add(new THREE.BoxGeometry(chassisWidth * 0.97, 0.15, chassisLength * 0.2), bodyMat, 0, -0.02, -chassisLength * 0.39);
  add(new THREE.BoxGeometry(chassisWidth, 0.3, 0.2), trimMat, 0, -0.35, -chassisLength * 0.4875);

  // Grille + rectangular headlights.
  add(new THREE.BoxGeometry(0.5, 0.15, 0.03), trimMat, 0, -0.15, chassisLength * 0.49);
  add(new THREE.BoxGeometry(0.35, 0.18, 0.05), lightMat, chassisWidth * 0.36, -0.1, chassisLength * 0.49);
  add(new THREE.BoxGeometry(0.35, 0.18, 0.05), lightMat, -chassisWidth * 0.36, -0.1, chassisLength * 0.49);

  // Round rally fog lights (Impreza GC trademark).
  const fogGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.06, 12);
  fogGeo.rotateX(Math.PI / 2);
  add(fogGeo, fogMat, chassisWidth * 0.28, -0.42, chassisLength * 0.5);
  add(fogGeo.clone(), fogMat, -chassisWidth * 0.28, -0.42, chassisLength * 0.5);

  // Taillights.
  add(new THREE.BoxGeometry(0.3, 0.15, 0.05), tailMat, chassisWidth * 0.42, 0, -chassisLength * 0.49);
  add(new THREE.BoxGeometry(0.3, 0.15, 0.05), tailMat, -chassisWidth * 0.42, 0, -chassisLength * 0.49);

  // Hood scoop (WRX icon).
  add(new THREE.BoxGeometry(0.45, 0.08, 0.4), trimMat, 0, 0.11, chassisLength * 0.325);

  // Side mirrors.
  add(new THREE.BoxGeometry(0.1, 0.08, 0.15), bodyMat, chassisWidth * 0.53, 0.15, chassisLength * 0.15);
  add(new THREE.BoxGeometry(0.1, 0.08, 0.15), bodyMat, -chassisWidth * 0.53, 0.15, chassisLength * 0.15);

  // Rear STI wing on struts.
  const strutGeo = new THREE.BoxGeometry(0.05, 0.35, 0.05);
  add(strutGeo, trimMat, chassisWidth * 0.36, 0.2, -chassisLength * 0.46);
  add(strutGeo.clone(), trimMat, -chassisWidth * 0.36, 0.2, -chassisLength * 0.46);
  add(new THREE.BoxGeometry(chassisWidth * 0.9, 0.05, 0.35), trimMat, 0, 0.38, -chassisLength * 0.46);

  parts.forEach((mesh) => group.add(mesh));
  return group;
}

/**
 * Builds a two-tone low-poly rally wheel: a black tire cylinder plus a
 * smaller gold octagonal "rim" cylinder for a BBS-style mesh-wheel look.
 */
function buildRallyWheel(radius, THREE_scene) {
  const group = new THREE.Group();

  const tireGeo = new THREE.CylinderGeometry(radius, radius, 0.3, 20);
  tireGeo.rotateZ(Math.PI / 2);
  const tire = new THREE.Mesh(tireGeo, new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 }));
  tire.castShadow = true;
  group.add(tire);

  const rimGeo = new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, 0.32, 8);
  rimGeo.rotateZ(Math.PI / 2);
  const rim = new THREE.Mesh(rimGeo, new THREE.MeshStandardMaterial({ color: 0xcda434, metalness: 0.8, roughness: 0.35 }));
  rim.castShadow = true;
  group.add(rim);

  THREE_scene.add(group);
  return group;
}

/**
 * Creates a Cannon-es RaycastVehicle (suspension, wheel friction,
 * acceleration) for the physics body, plus a matching low-poly
 * Subaru Impreza GC Three.js mesh.
 */
export function createCar(
  world,
  THREE_scene,
  startPosition = new CANNON.Vec3(0, 1, 0),
  startQuaternion = new CANNON.Quaternion(0, 0, 0, 1)
) {
  // --- Chassis physics body ---
  const chassisWidth = 1.8;
  const chassisHeight = 0.6;
  const chassisLength = 4;

  // cannon-es's narrowphase only implements Sphere<->Trimesh collision, not
  // Box<->Trimesh (ConvexPolyhedron<->Trimesh is unimplemented/commented out
  // in the library). A single CANNON.Box shape therefore never actually
  // collides with the real-world terrain (a Trimesh) - the car would only
  // stay up via the wheels' raycasts, and a hard crash/rollover would fall
  // straight through the ground. As a simplified hitbox, approximate the
  // chassis box with a sphere at each of its 8 corners instead: spheres do
  // collide with Trimesh, so the body can now physically hit the ground and
  // tumble/roll when it flips, while still roughly matching the visible box.
  const hitboxRadius = Math.min(chassisWidth, chassisHeight) / 2 - 0.05;
  const chassisBody = new CANNON.Body({ mass: 150 });
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        chassisBody.addShape(
          new CANNON.Sphere(hitboxRadius),
          new CANNON.Vec3(
            sx * (chassisWidth / 2 - hitboxRadius),
            sy * (chassisHeight / 2 - hitboxRadius),
            sz * (chassisLength / 2 - hitboxRadius)
          )
        );
      }
    }
  }
  chassisBody.position.copy(startPosition);
  chassisBody.quaternion.copy(startQuaternion);
  chassisBody.angularVelocity.set(0, 0, 0);

  // --- Vehicle ---
  const vehicle = new CANNON.RaycastVehicle({
    chassisBody,
    indexRightAxis: 0,
    indexUpAxis: 1,
    indexForwardAxis: 2,
  });

  const wheelOptions = {
    radius: 0.4,
    directionLocal: new CANNON.Vec3(0, -1, 0),
    suspensionStiffness: 18,
    suspensionRestLength: 0.55,
    frictionSlip: 5,
    dampingRelaxation: 2.1,
    dampingCompression: 3.2,
    maxSuspensionForce: 100000,
    rollInfluence: 0.01,
    axleLocal: new CANNON.Vec3(-1, 0, 0),
    chassisConnectionPointLocal: new CANNON.Vec3(1, 0, 1),
    maxSuspensionTravel: 0.7,
    customSlidingRotationalSpeed: -30,
    useCustomSlidingRotationalSpeed: true,
  };

  const axleWidth = chassisWidth / 2 - 0.1;
  const wheelFront = 1.3;
  const wheelBack = -1.3;
  // attach wheels at the chassis underside (not the center) for pitch/roll stability
  const wheelAttachY = -chassisHeight / 2;

  const wheelPositions = [
    new CANNON.Vec3(-axleWidth, wheelAttachY, wheelFront), // front-left
    new CANNON.Vec3(axleWidth, wheelAttachY, wheelFront), // front-right
    new CANNON.Vec3(-axleWidth, wheelAttachY, wheelBack), // rear-left
    new CANNON.Vec3(axleWidth, wheelAttachY, wheelBack), // rear-right
  ];

  wheelPositions.forEach((pos) => {
    vehicle.addWheel({ ...wheelOptions, chassisConnectionPointLocal: pos });
  });

  vehicle.addToWorld(world);

  // --- Three.js mesh: low-poly Subaru Impreza GC (90s WRX/STI rally style) ---
  // Built entirely from primitive boxes/cylinders to keep it low-poly, sized
  // to roughly match the chassis hitbox (chassisWidth x chassisLength) so it
  // still lines up with the wheels and physics body.
  const chassisMesh = buildImprezaBody(chassisWidth, chassisLength);
  THREE_scene.add(chassisMesh);

  // Debug-only wireframe spheres marking the chassis' actual physics
  // hitbox (the 8 corner spheres added above) - parented directly to
  // chassisMesh, whose transform tracks chassisBody 1:1 (see syncMeshes
  // below), so these move/rotate with the car for free.
  const hitboxMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, depthTest: false });
  const hitboxMeshes = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const sphereMesh = new THREE.Mesh(new THREE.SphereGeometry(hitboxRadius, 8, 6), hitboxMaterial);
        sphereMesh.position.set(
          sx * (chassisWidth / 2 - hitboxRadius),
          sy * (chassisHeight / 2 - hitboxRadius),
          sz * (chassisLength / 2 - hitboxRadius)
        );
        sphereMesh.visible = false;
        sphereMesh.renderOrder = 999;
        chassisMesh.add(sphereMesh);
        hitboxMeshes.push(sphereMesh);
      }
    }
  }
  function setHitboxVisible(visible) {
    for (const m of hitboxMeshes) m.visible = visible;
  }

  const wheelMeshes = wheelPositions.map(() => buildRallyWheel(wheelOptions.radius, THREE_scene));

  // --- Fixed-step physics / variable-rate render decoupling ---
  // world.step() advances the simulation in discrete FIXED_STEP chunks, but
  // requestAnimationFrame deltas rarely divide evenly into that step, so the
  // number of physics substeps taken can flicker between e.g. 1 and 2 from
  // frame to frame. At high speed that shows up as visible jitter/stutter
  // (the car covers a different distance each render frame even though real
  // motion is smooth). Fix: snapshot the previous/current physics transform
  // every fixed step, then interpolate between them for rendering using how
  // far we are into the next step (alpha), independent of render frame rate.
  const prevChassisPos = new THREE.Vector3().copy(chassisBody.position);
  const currChassisPos = new THREE.Vector3().copy(chassisBody.position);
  const prevChassisQuat = new THREE.Quaternion().copy(chassisBody.quaternion);
  const currChassisQuat = new THREE.Quaternion().copy(chassisBody.quaternion);

  const prevWheelPos = wheelPositions.map(() => new THREE.Vector3());
  const currWheelPos = wheelPositions.map(() => new THREE.Vector3());
  const prevWheelQuat = wheelPositions.map(() => new THREE.Quaternion());
  const currWheelQuat = wheelPositions.map(() => new THREE.Quaternion());

  function readWheelTransforms(targetPosArr, targetQuatArr) {
    vehicle.wheelInfos.forEach((wheel, i) => {
      vehicle.updateWheelTransform(i);
      const t = wheel.worldTransform;
      targetPosArr[i].copy(t.position);
      targetQuatArr[i].copy(t.quaternion);
    });
  }
  readWheelTransforms(prevWheelPos, prevWheelQuat);
  readWheelTransforms(currWheelPos, currWheelQuat);

  // Call this once right after every fixed world.step() (not once per render
  // frame) so prev/curr always bracket exactly one physics step.
  function snapshotPhysics() {
    prevChassisPos.copy(currChassisPos);
    prevChassisQuat.copy(currChassisQuat);
    currChassisPos.copy(chassisBody.position);
    currChassisQuat.copy(chassisBody.quaternion);

    for (let i = 0; i < wheelPositions.length; i++) {
      prevWheelPos[i].copy(currWheelPos[i]);
      prevWheelQuat[i].copy(currWheelQuat[i]);
    }
    readWheelTransforms(currWheelPos, currWheelQuat);
  }

  // Snaps prev === curr at the current physics state, so the next render
  // doesn't interpolate from a stale pre-teleport transform (used on reset).
  function resetInterpolation() {
    currChassisPos.copy(chassisBody.position);
    currChassisQuat.copy(chassisBody.quaternion);
    prevChassisPos.copy(currChassisPos);
    prevChassisQuat.copy(currChassisQuat);

    readWheelTransforms(currWheelPos, currWheelQuat);
    for (let i = 0; i < wheelPositions.length; i++) {
      prevWheelPos[i].copy(currWheelPos[i]);
      prevWheelQuat[i].copy(currWheelQuat[i]);
    }
  }

  // alpha in [0, 1]: how far between the previous and current physics step
  // we are when this render frame fires. Pass 1 (default) to skip
  // interpolation and snap straight to the latest physics state.
  function syncMeshes(alpha = 1) {
    chassisMesh.position.lerpVectors(prevChassisPos, currChassisPos, alpha);
    chassisMesh.quaternion.slerpQuaternions(prevChassisQuat, currChassisQuat, alpha);

    wheelMeshes.forEach((mesh, i) => {
      mesh.position.lerpVectors(prevWheelPos[i], currWheelPos[i], alpha);
      mesh.quaternion.slerpQuaternions(prevWheelQuat[i], currWheelQuat[i], alpha);
    });
  }

  // With no arguments, rights the car where it currently is: keeps its
  // current x/z position (and lifts it a bit above its current spot in case
  // it landed on its roof/side) instead of teleporting back to the spawn
  // point. Pass explicit position/quaternion to override that behavior.
  function reset(position, quaternion) {
    const targetPosition = position ?? chassisBody.position.clone();
    if (!position) targetPosition.y += chassisHeight + 0.5;
    const targetQuaternion = quaternion ?? uprightQuaternionPreservingHeading();

    chassisBody.position.copy(targetPosition);
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    chassisBody.quaternion.copy(targetQuaternion);

    resetInterpolation();
  }

  // Keeps the car's current heading (yaw) but zeroes out any roll/pitch,
  // so an in-place reset rights a flipped car facing the same direction.
  function uprightQuaternionPreservingHeading() {
    const euler = new CANNON.Vec3();
    chassisBody.quaternion.toEuler(euler);
    const upright = new CANNON.Quaternion();
    upright.setFromEuler(0, euler.y, 0);
    return upright;
  }

  return { vehicle, chassisBody, chassisMesh, wheelMeshes, syncMeshes, snapshotPhysics, reset, setHitboxVisible };
}
