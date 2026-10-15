import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';

const DEFAULT_BODY_COLOR = 0xcc2222;

export function buildBody(chassisWidth, chassisLength, color = DEFAULT_BODY_COLOR) {
    const group = new THREE.Group();

    const bodyMat = createPaintMaterial(color, {
        metalness: 0.4,
        roughness: 0.3
    });

    const darkMat = new THREE.MeshStandardMaterial({ color: 0x181818 });
    const glassMat = createGlossyMaterial({
        color: 0x182530,
        metalness: 0.4,
        roughness: 0.2
    });

    const add = (geometry, material, x, y, z) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y-0.8, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        return mesh;
    };

    const w = chassisWidth;
    const l = chassisLength;

    // Niskie, wydłużone nadwozie
    add(
        new THREE.BoxGeometry(w * 0.65, w * 0.18, l * 0.85),
        bodyMat, 0, w * 0.35, 0
    );

    // Długi, zwężający się nos
    const noseShape = new THREE.Shape();
    noseShape.moveTo(-w * 0.32, 0);
    noseShape.lineTo(w * 0.32, 0);
    noseShape.lineTo(w * 0.12, l * 0.48);
    noseShape.lineTo(-w * 0.12, l * 0.48);
    noseShape.closePath();

    const noseGeo = new THREE.ExtrudeGeometry(noseShape, {
        depth: w * 0.12,
        bevelEnabled: true,
        bevelSegments: 1,
        steps: 1,
        bevelSize: w * 0.015,
        bevelThickness: w * 0.015
    });

    noseGeo.rotateX(Math.PI / 2);
    noseGeo.translate(0, w * 0.38, l * 0.05);
    add(noseGeo, bodyMat, 0, 0, 0);

    // Mała kabina blisko tyłu
    add(
        new THREE.BoxGeometry(w * 0.38, w * 0.3, l * 0.16),
        bodyMat, 0, w * 0.55, -l * 0.18
    );

    add(
        new THREE.BoxGeometry(w * 0.3, w * 0.2, l * 0.13),
        glassMat, 0, w * 0.72, -l * 0.18
    );

    // Duży tylny spojler
    add(
        new THREE.BoxGeometry(w * 1.5, w * 0.06, l * 0.1),
        darkMat, 0, w * 0.85, -l * 0.43
    );

    // Wsporniki spojlera
    for (const x of [-w * 0.35, w * 0.35]) {
        add(
            new THREE.BoxGeometry(w * 0.035, w * 0.4, w * 0.035),
            darkMat, x, w * 0.65, -l * 0.43
        );
    }

    // Boczne rury wydechowe
    for (const x of [-1, 1]) {
        const exhaust = new THREE.CylinderGeometry(
            w * 0.035, w * 0.035, l * 0.3, 8
        );
        exhaust.rotateX(Math.PI / 2);

        add(exhaust, darkMat, x * w * 0.36, w * 0.25, -l * 0.05);
    }

    // Tylne błotniki
    for (const x of [-1, 1]) {
        add(
            new THREE.BoxGeometry(w * 0.15, w * 0.12, l * 0.25),
            bodyMat, x * w * 0.4, w * 0.38, -l * 0.28
        );
    }

    return { group, bodyMat };
}