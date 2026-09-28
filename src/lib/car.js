import * as THREE from 'three';
import * as CANNON from 'cannon-es';

/**
 * Creates a simple box "car" with a Cannon-es RaycastVehicle for physics
 * (suspension, wheel friction, acceleration) and a matching solid-box
 * Three.js mesh (no car model yet - solid placeholder as requested).
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

  const chassisShape = new CANNON.Box(
    new CANNON.Vec3(chassisWidth / 2, chassisHeight / 2, chassisLength / 2)
  );
  const chassisBody = new CANNON.Body({ mass: 150 });
  chassisBody.addShape(chassisShape);
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
    suspensionStiffness: 30,
    suspensionRestLength: 0.45,
    frictionSlip: 5,
    dampingRelaxation: 2.8,
    dampingCompression: 4.6,
    maxSuspensionForce: 100000,
    rollInfluence: 0.01,
    axleLocal: new CANNON.Vec3(-1, 0, 0),
    chassisConnectionPointLocal: new CANNON.Vec3(1, 0, 1),
    maxSuspensionTravel: 0.45,
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

  // --- Three.js meshes (solid placeholders) ---
  const chassisMesh = new THREE.Mesh(
    new THREE.BoxGeometry(chassisWidth, chassisHeight, chassisLength),
    new THREE.MeshStandardMaterial({ color: 0xd23c3c, metalness: 0.3, roughness: 0.5 })
  );
  chassisMesh.castShadow = true;
  THREE_scene.add(chassisMesh);

  const wheelMeshes = wheelPositions.map(() => {
    const wheelGeometry = new THREE.CylinderGeometry(wheelOptions.radius, wheelOptions.radius, 0.3, 20);
    // bake the axle rotation into the geometry: syncMeshes() overwrites the
    // mesh quaternion every frame from vehicle physics, so a mesh.rotation
    // set here would otherwise be discarded immediately.
    wheelGeometry.rotateZ(Math.PI / 2);
    const mesh = new THREE.Mesh(
      wheelGeometry,
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 })
    );
    mesh.castShadow = true;
    THREE_scene.add(mesh);
    return mesh;
  });

  function syncMeshes() {
    chassisMesh.position.copy(chassisBody.position);
    chassisMesh.quaternion.copy(chassisBody.quaternion);

    vehicle.wheelInfos.forEach((wheel, i) => {
      vehicle.updateWheelTransform(i);
      const t = wheel.worldTransform;
      wheelMeshes[i].position.copy(t.position);
      wheelMeshes[i].quaternion.copy(t.quaternion);
    });
  }

  function reset(position = startPosition, quaternion = startQuaternion) {
    chassisBody.position.copy(position);
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    chassisBody.quaternion.copy(quaternion);
  }

  return { vehicle, chassisBody, chassisMesh, wheelMeshes, syncMeshes, reset };
}
