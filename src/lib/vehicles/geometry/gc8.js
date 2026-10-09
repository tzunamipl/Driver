import * as THREE from 'three';

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

export function buildBody(chassisWidth, chassisLength, color = DEFAULT_BODY_COLOR) {
    const group = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.45 });
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
    return { group, bodyMat };
}