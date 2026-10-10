import * as THREE from 'three';

export function buildBody(
    chassisWidth,
    chassisLength,
    color = DEFAULT_BODY_COLOR
) {
    const group = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({
        color,
        metalness: 0.35,
        roughness: 0.5
    });

    const glassMat = new THREE.MeshStandardMaterial({
        color: 0x18212b,
        metalness: 0.25,
        roughness: 0.3
    });

    const trimMat = new THREE.MeshStandardMaterial({
        color: 0x171717,
        roughness: 0.7
    });

    const lightMat = new THREE.MeshStandardMaterial({
        color: 0xfff0c0,
        emissive: 0x332200
    });

    const tailMat = new THREE.MeshStandardMaterial({
        color: 0x990f16,
        emissive: 0x220000
    });

    const addBox = (w, h, d, material, x, y, z) => {
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, d),
            material
        );
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        return mesh;
    };

    const w = chassisWidth;
    const l = chassisLength;

    // Lower body
    addBox(w, 0.45, l * 0.94, bodyMat, 0, -0.3, 0);

    // Hood
    addBox(w * 0.96, 0.12, l * 0.30, bodyMat, 0, -0.02, l * 0.32);

    // Long wagon roof and upright rear cabin
    addBox(w * 0.82, 0.55, l * 0.68, bodyMat, 0, 0.18, -l * 0.06);

    // Upright rear hatch window
    addBox(w * 0.70, 0.38, 0.035, glassMat, 0, 0.30, -l * 0.40);

    // Rear hatch
    addBox(w * 0.78, 0.42, 0.04, bodyMat, 0, 0.12, -l * 0.46);

    // Side windows
    for (const side of [-1, 1]) {
        const x = side * w * 0.414;

        addBox(0.025, 0.34, l * 0.22, glassMat, x, 0.30, l * 0.075);
        addBox(0.025, 0.34, l * 0.20, glassMat, x, 0.30, -l * 0.17);

        // Window pillars
        addBox(0.045, 0.48, 0.055, bodyMat, x, 0.28, l * 0.18);
        addBox(0.045, 0.48, 0.055, bodyMat, x, 0.28, -l * 0.07);
        addBox(0.045, 0.48, 0.055, bodyMat, x, 0.28, -l * 0.28);

        // Mirrors
        addBox(0.13, 0.09, 0.16, bodyMat, side * w * 0.53, 0.12, l * 0.16);
    }

    // Front grille
    addBox(w * 0.32, 0.13, 0.035, trimMat, 0, -0.18, l * 0.482);

    // Headlights
    for (const side of [-1, 1]) {
        addBox(w * 0.25, 0.16, 0.045, lightMat,
            side * w * 0.34, -0.13, l * 0.485);

        // Taillights
        addBox(w * 0.12, 0.23, 0.045, tailMat,
            side * w * 0.40, -0.04, -l * 0.485);
    }

    // Bumpers
    addBox(w * 1.02, 0.18, 0.15, trimMat, 0, -0.42, l * 0.47);
    addBox(w * 1.02, 0.18, 0.15, trimMat, 0, -0.42, -l * 0.47);

    // Hood scoop
    addBox(w * 0.25, 0.06, l * 0.08, trimMat, 0, 0.06, l * 0.32);

    // Roof rails
    for (const side of [-1, 1]) {
        addBox(0.045, 0.045, l * 0.46, trimMat,
            side * w * 0.32, 0.48, -l * 0.025);
    }

    return { group, bodyMat };
}