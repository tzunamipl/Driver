import * as THREE from 'three';

export function buildBody(chassisWidth, chassisLength, color = DEFAULT_BODY_COLOR) {
    const group = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.55 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.2, roughness: 0.8 });
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.9, roughness: 0.2 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x141a20, metalness: 0.6, roughness: 0.15 });
    const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff3cf, emissive: 0x554417, roughness: 0.3 });
    const flameMat = new THREE.MeshStandardMaterial({ color: 0xff9a1f, emissive: 0xff5a00, emissiveIntensity: 1.1, roughness: 0.35 });

    const parts = [];
    const add = (geometry, material, x, y, z) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        parts.push(mesh);
        return mesh;
    };

    // High-riding main chassis rail/frame - sits well above the (comparatively
    // tiny) stock chassis footprint since the huge wheels (see wheelRadius in
    // the descriptor below) push the whole truck much higher off the ground.
    add(new THREE.BoxGeometry(chassisWidth, 0.45, chassisLength * 0.95), trimMat, 0, -0.35, 0);

    // Cab (front half) - boxy, upright, high greenhouse.
    add(new THREE.BoxGeometry(chassisWidth * 0.92, 0.65, chassisLength * 0.42), bodyMat, 0, 0.2, chassisLength * 0.18);
    add(new THREE.BoxGeometry(chassisWidth * 0.8, 0.4, chassisLength * 0.34), glassMat, 0, 0.58, chassisLength * 0.17);

    // Open truck bed (rear half) - low side rails, flat floor.
    add(new THREE.BoxGeometry(chassisWidth * 0.92, 0.08, chassisLength * 0.4), bodyMat, 0, -0.08, -chassisLength * 0.27);
    add(new THREE.BoxGeometry(chassisWidth * 0.92, 0.3, 0.06), bodyMat, 0, 0.07, -chassisLength * 0.47);
    add(new THREE.BoxGeometry(0.06, 0.3, chassisLength * 0.4), bodyMat, chassisWidth * 0.46, 0.07, -chassisLength * 0.27);
    add(new THREE.BoxGeometry(0.06, 0.3, chassisLength * 0.4), bodyMat, -chassisWidth * 0.46, 0.07, -chassisLength * 0.27);

    // Hood + round headlights.
    add(new THREE.BoxGeometry(chassisWidth * 0.9, 0.18, chassisLength * 0.22), bodyMat, 0, -0.05, chassisLength * 0.42);
    const lightGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.08, 12);
    lightGeo.rotateX(Math.PI / 2);
    add(lightGeo, lightMat, chassisWidth * 0.32, -0.08, chassisLength * 0.5);
    add(lightGeo.clone(), lightMat, -chassisWidth * 0.32, -0.08, chassisLength * 0.5);

    // Flame decals streaking back from the headlights across the hood.
    add(new THREE.BoxGeometry(0.4, 0.02, chassisLength * 0.3), flameMat, chassisWidth * 0.22, 0.041, chassisLength * 0.32);
    add(new THREE.BoxGeometry(0.4, 0.02, chassisLength * 0.3), flameMat, -chassisWidth * 0.22, 0.041, chassisLength * 0.32);

    // Heavy chrome front/rear bumpers (classic monster-truck "tube" look).
    const bumperGeo = new THREE.CylinderGeometry(0.09, 0.09, chassisWidth * 1.05, 10);
    bumperGeo.rotateZ(Math.PI / 2);
    add(bumperGeo, chromeMat, 0, -0.42, chassisLength * 0.5);
    add(bumperGeo.clone(), chromeMat, 0, -0.42, -chassisLength * 0.5);

    // Roll cage over the cab.
    const cageGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.6, 8);
    for (const sx of [-1, 1]) {
        const bar = cageGeo.clone();
        add(bar, chromeMat, sx * chassisWidth * 0.4, 0.55, chassisLength * 0.02);
    }
    add(new THREE.BoxGeometry(chassisWidth * 0.82, 0.05, 0.05), chromeMat, 0, 0.85, chassisLength * 0.02);

    // Tall whip antenna + roof light bar, so it reads as a monster truck even
    // from a distance where the huge wheels are the only other tell.
    add(new THREE.BoxGeometry(0.3, 0.08, 0.12), lightMat, 0, 0.62, chassisLength * 0.3);

    parts.forEach((mesh) => group.add(mesh));
    return { group, bodyMat };
}