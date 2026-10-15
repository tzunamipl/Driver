import * as THREE from 'three';
import { createPaintMaterial } from './paint.js';

const DEFAULT_BODY_COLOR = 0xcc2222;

export function buildBody(chassisWidth, chassisLength, color = DEFAULT_BODY_COLOR) {
    const group = new THREE.Group();

    const bodyMat = createPaintMaterial(color, {
        metalness: 0.3,
        roughness: 0.55
    });

    const trimMat = new THREE.MeshStandardMaterial({
        color: 0x222222,
        metalness: 0.2,
        roughness: 0.8
    });

    const add = (geometry, material, x, y, z) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y-0.3, z);
        mesh.castShadow = true;
        group.add(mesh);
        return mesh;
    };

    const bodyHeight = chassisWidth * 0.3;
    const cabinLength = chassisLength * 0.4;
    const cabinWidth = chassisWidth * 0.75;
    const cabinHeight = bodyHeight * 0.8;

    // Główne nadwozie
    add(
        new THREE.BoxGeometry(chassisWidth, bodyHeight, chassisLength),
        bodyMat, 0, bodyHeight / 2, 0
    );

    // Kabina
    add(
        new THREE.BoxGeometry(cabinWidth, cabinHeight, cabinLength),
        trimMat, 0, bodyHeight + cabinHeight / 2, -chassisLength * 0.05
    );

    // Maska
    add(
        new THREE.BoxGeometry(chassisWidth * 0.9, bodyHeight * 0.25, chassisLength * 0.3),
        bodyMat, 0, bodyHeight * 0.85, chassisLength * 0.3
    );

    // Przedni zderzak
    add(
        new THREE.BoxGeometry(chassisWidth * 0.95, bodyHeight * 0.15, chassisLength * 0.04),
        trimMat, 0, bodyHeight * 0.2, chassisLength * 0.5
    );

    // Tylny spojler
    add(
        new THREE.BoxGeometry(chassisWidth * 0.8, bodyHeight * 0.08, chassisLength * 0.04),
        trimMat, 0, bodyHeight * 1.5, -chassisLength * 0.42
    );

    return { group, bodyMat };
}