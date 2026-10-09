import * as THREE from 'three';

export function buildBody(chassisWidth, chassisLength, color = DEFAULT_BODY_COLOR) {
    const group = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({
        color,
        metalness: 0.35,
        roughness: 0.42
    });

    const bodyDarkMat = new THREE.MeshStandardMaterial({
        color: 0x171717,
        metalness: 0.15,
        roughness: 0.75
    });

    const glassMat = new THREE.MeshStandardMaterial({
        color: 0x111820,
        metalness: 0.55,
        roughness: 0.16
    });

    const headlightMat = new THREE.MeshStandardMaterial({
        color: 0xfff5d8,
        emissive: 0x403817,
        roughness: 0.22
    });

    const tailLightMat = new THREE.MeshStandardMaterial({
        color: 0x7d1014,
        emissive: 0x300000,
        roughness: 0.3
    });

    const fogMat = new THREE.MeshStandardMaterial({
        color: 0xffd77a,
        emissive: 0x664400,
        roughness: 0.3
    });

    const parts = [];

    const add = (geometry, material, x = 0, y = 0, z = 0) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        parts.push(mesh);
        return mesh;
    };

    const W = chassisWidth;
    const L = chassisLength;

    // ============================================================
    // Helpers
    // ============================================================

    /*
     * Creates a low-poly body from longitudinal sections.
     *
     * Each section:
     *   z     = longitudinal position
     *   width = half width
     *   y     = top of the body
     *
     * The resulting mesh has a curved/angled shoulder rather than
     * being a collection of rectangular boxes.
     */
    function createBodyShell(sections) {
        const vertices = [];
        const indices = [];

        /*
         * Cross-section:
         *
         *        top
         *      /-----\
         *     /       \
         *    /         \
         *   /           \
         *  bottom       bottom
         *
         * Six points around the body give us pronounced shoulders.
         */
        const ring = [
            [-1.00, -0.22],
            [-0.96,  0.02],
            [-0.78,  0.18],
            [ 0.78,  0.18],
            [ 0.96,  0.02],
            [ 1.00, -0.22]
        ];

        for (const s of sections) {
            for (const [x, y] of ring) {
                vertices.push(
                    x * s.width,
                    y + s.height,
                    s.z
                );
            }
        }

        const ringSize = ring.length;

        for (let i = 0; i < sections.length - 1; i++) {
            const a = i * ringSize;
            const b = (i + 1) * ringSize;

            for (let j = 0; j < ringSize - 1; j++) {
                indices.push(
                    a + j,
                    b + j,
                    a + j + 1,

                    a + j + 1,
                    b + j,
                    b + j + 1
                );
            }
        }

        // Front cap
        for (let j = 1; j < ringSize - 1; j++) {
            indices.push(0, j + 1, j);
        }

        // Rear cap
        const last = (sections.length - 1) * ringSize;

        for (let j = 1; j < ringSize - 1; j++) {
            indices.push(
                last,
                last + j,
                last + j + 1
            );
        }

        const geometry = new THREE.BufferGeometry();

        geometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(vertices, 3)
        );

        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        return geometry;
    }

    // ============================================================
    // MAIN BODY
    // ============================================================

    const bodyGeo = createBodyShell([
        // front bumper
        {
            z: L * 0.49,
            width: W * 0.47,
            height: 0
        },

        // front nose
        {
            z: L * 0.43,
            width: W * 0.50,
            height: 0.02
        },

        // front wheel area
        {
            z: L * 0.30,
            width: W * 0.51,
            height: 0.02
        },

        // between wheels
        {
            z: L * 0.08,
            width: W * 0.515,
            height: 0.03
        },

        // rear wheel area
        {
            z: -L * 0.25,
            width: W * 0.52,
            height: 0.025
        },

        // rear quarter
        {
            z: -L * 0.40,
            width: W * 0.50,
            height: 0.02
        },

        // rear bumper
        {
            z: -L * 0.49,
            width: W * 0.46,
            height: -0.01
        }
    ]);

    add(bodyGeo, bodyMat);

    // ============================================================
    // LOWER SIDE SKIRTS
    // ============================================================

    add(
        new THREE.BoxGeometry(
            W * 0.94,
            0.10,
            L * 0.64
        ),
        bodyDarkMat,
        0,
        -0.30,
        -L * 0.02
    );

    // ============================================================
    // HOOD
    // ============================================================

    /*
     * Hood is deliberately wedge-shaped rather than a box.
     */

    const hoodVertices = [
        -W * 0.46, 0.00, L * 0.47,
        W * 0.46, 0.00, L * 0.47,

        -W * 0.44, 0.14, L * 0.22,
        W * 0.44, 0.14, L * 0.22,

        -W * 0.36, 0.20, L * 0.15,
        W * 0.36, 0.20, L * 0.15
    ];

    const hoodIndices = [
        0, 1, 3,
        0, 3, 2,

        2, 3, 5,
        2, 5, 4,

        0, 2, 4,
        0, 4, 1,

        1, 4, 5,
        1, 5, 3
    ];

    const hoodGeo = new THREE.BufferGeometry();

    hoodGeo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(hoodVertices, 3)
    );

    hoodGeo.setIndex(hoodIndices);
    hoodGeo.computeVertexNormals();

    add(hoodGeo, bodyMat);

    // ============================================================
    // CABIN / ROOF
    // ============================================================

    /*
     * The Levorg has a long wagon roof.
     * This is intentionally much longer than on the GC Impreza.
     */

    const cabinVertices = [
        // front lower
        -W * 0.40, 0.18, L * 0.18,
        W * 0.40, 0.18, L * 0.18,

        // windshield top
        -W * 0.34, 0.62, L * 0.04,
        W * 0.34, 0.62, L * 0.04,

        // roof front
        -W * 0.30, 0.70, -L * 0.02,
        W * 0.30, 0.70, -L * 0.02,

        // roof rear
        -W * 0.29, 0.70, -L * 0.30,
        W * 0.29, 0.70, -L * 0.30,

        // rear hatch top
        -W * 0.34, 0.48, -L * 0.43,
        W * 0.34, 0.48, -L * 0.43
    ];

    const cabinIndices = [
        // left side
        0, 2, 4,
        0, 4, 6,
        6, 8, 0,

        // right side
        1, 5, 3,
        1, 7, 5,
        1, 9, 7,

        // roof
        4, 5, 7,
        4, 7, 6,

        // windshield
        0, 1, 3,
        0, 3, 2,

        // rear hatch
        6, 7, 9,
        6, 9, 8
    ];

    const cabinGeo = new THREE.BufferGeometry();

    cabinGeo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(cabinVertices, 3)
    );

    cabinGeo.setIndex(cabinIndices);
    cabinGeo.computeVertexNormals();

    add(cabinGeo, bodyMat);



    // ============================================================
    // WINDOWS
    // ============================================================

    // Windshield
    const windshield = new THREE.BufferGeometry();

    windshield.setAttribute(
        "position",
        new THREE.Float32BufferAttribute([
            -W * 0.325, 0.39, L * 0.17,
            W * 0.325, 0.39, L * 0.17,

            W * 0.285, 0.61, L * 0.035,
            -W * 0.285, 0.61, L * 0.035
        ], 3)
    );

    windshield.setIndex([
        0, 1, 2,
        0, 2, 3
    ]);

    windshield.computeVertexNormals();

    add(windshield, glassMat);

    // ============================================================
    // SIDE WINDOWS
    // ============================================================

    function createSideWindow(x, mirror = false) {
        const side = mirror ? -1 : 1;

        const vertices = [
            side * W * 0.405, 0.34, L * 0.13,
            side * W * 0.335, 0.60, L * 0.025,
            side * W * 0.285, 0.64, -L * 0.03,
            side * W * 0.275, 0.64, -L * 0.27,
            side * W * 0.325, 0.43, -L * 0.40
        ];

        const geo = new THREE.BufferGeometry();

        geo.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(vertices, 3)
        );

        geo.setIndex([
            0, 1, 2,
            0, 2, 4,
            4, 2, 3
        ]);

        geo.computeVertexNormals();

        return add(geo, glassMat);
    }

    createSideWindow(W, false);
    createSideWindow(W, true);

    // ============================================================
    // B-PILLARS / C-PILLARS
    // ============================================================

    const pillar = new THREE.BoxGeometry(
        0.045,
        0.34,
        0.045
    );

    add(
        pillar,
        bodyDarkMat,
        W * 0.31,
        0.50,
        -L * 0.01
    );

    add(
        pillar.clone(),
        bodyDarkMat,
        -W * 0.31,
        0.50,
        -L * 0.01
    );

    add(
        pillar.clone(),
        bodyDarkMat,
        W * 0.29,
        0.48,
        -L * 0.29
    );

    add(
        pillar.clone(),
        bodyDarkMat,
        -W * 0.29,
        0.48,
        -L * 0.29
    );

    // ============================================================
    // FRONT GRILLE
    // ============================================================

    const grilleShape = new THREE.Shape();

    grilleShape.moveTo(-0.28, 0);
    grilleShape.lineTo(0.28, 0);
    grilleShape.lineTo(0.20, 0.17);
    grilleShape.lineTo(-0.20, 0.17);
    grilleShape.closePath();

    const grilleGeo = new THREE.ExtrudeGeometry(
        grilleShape,
        {
            depth: 0.035,
            bevelEnabled: false
        }
    );

    grilleGeo.rotateX(Math.PI / 2);

    add(
        grilleGeo,
        bodyDarkMat,
        0,
        -0.13,
        L * 0.495
    );

    // ============================================================
    // HEADLIGHTS
    // ============================================================

    const headlightShape = new THREE.Shape();

    headlightShape.moveTo(-0.22, 0.00);
    headlightShape.lineTo(0.20, 0.02);
    headlightShape.lineTo(0.15, 0.15);
    headlightShape.lineTo(-0.16, 0.13);
    headlightShape.closePath();

    const headlightGeo = new THREE.ExtrudeGeometry(
        headlightShape,
        {
            depth: 0.04,
            bevelEnabled: false
        }
    );

    headlightGeo.rotateX(Math.PI / 2);

    add(
        headlightGeo,
        headlightMat,
        W * 0.30,
        -0.08,
        L * 0.492
    );

    add(
        headlightGeo.clone(),
        headlightMat,
        -W * 0.30,
        -0.08,
        L * 0.492
    );

    // ============================================================
    // FRONT AIR INTAKES
    // ============================================================

    const intake = new THREE.BoxGeometry(
        W * 0.18,
        0.09,
        0.035
    );

    add(
        intake,
        bodyDarkMat,
        W * 0.30,
        -0.27,
        L * 0.495
    );

    add(
        intake.clone(),
        bodyDarkMat,
        -W * 0.30,
        -0.27,
        L * 0.495
    );

    // ============================================================
    // FOG LIGHTS
    // ============================================================

    const fogGeo = new THREE.CylinderGeometry(
        0.075,
        0.075,
        0.055,
        10
    );

    fogGeo.rotateX(Math.PI / 2);

    add(
        fogGeo,
        fogMat,
        W * 0.32,
        -0.28,
        L * 0.498
    );

    add(
        fogGeo.clone(),
        fogMat,
        -W * 0.32,
        -0.28,
        L * 0.498
    );

    // ============================================================
    // HOOD SCOOP
    // ============================================================

    const scoopGeo = new THREE.BoxGeometry(
        W * 0.30,
        0.075,
        L * 0.075
    );

    add(
        scoopGeo,
        bodyDarkMat,
        0,
        0.22,
        L * 0.30
    );

    // Raised rear edge of scoop.
    add(
        new THREE.BoxGeometry(
            W * 0.30,
            0.055,
            0.035
        ),
        bodyDarkMat,
        0,
        0.26,
        L * 0.335
    );

    // ============================================================
    // SIDE MIRRORS
    // ============================================================

    const mirrorGeo = new THREE.BoxGeometry(
        0.13,
        0.08,
        0.18
    );

    add(
        mirrorGeo,
        bodyMat,
        W * 0.47,
        0.39,
        L * 0.12
    );

    add(
        mirrorGeo.clone(),
        bodyMat,
        -W * 0.47,
        0.39,
        L * 0.12
    );

    // ============================================================
    // REAR HATCH
    // ============================================================

    const hatchGeo = new THREE.BoxGeometry(
        W * 0.70,
        0.035,
        0.045
    );

    hatchGeo.rotateX(-0.18);

    add(
        hatchGeo,
        glassMat,
        0,
        0.47,
        -L * 0.445
    );

    // ============================================================
    // TAIL LIGHTS
    // ============================================================

    const tailShape = new THREE.Shape();

    tailShape.moveTo(-0.19, 0);
    tailShape.lineTo(0.19, 0);
    tailShape.lineTo(0.15, 0.16);
    tailShape.lineTo(-0.15, 0.16);
    tailShape.closePath();

    const tailGeo = new THREE.ExtrudeGeometry(
        tailShape,
        {
            depth: 0.045,
            bevelEnabled: false
        }
    );

    tailGeo.rotateX(Math.PI / 2);

    add(
        tailGeo,
        tailLightMat,
        W * 0.35,
        0.08,
        -L * 0.497
    );

    add(
        tailGeo.clone(),
        tailLightMat,
        -W * 0.35,
        0.08,
        -L * 0.497
    );

    // ============================================================
    // REAR BUMPER / DIFFUSER
    // ============================================================

    add(
        new THREE.BoxGeometry(
            W * 0.86,
            0.14,
            0.13
        ),
        bodyDarkMat,
        0,
        -0.28,
        -L * 0.485
    );

    // ============================================================
    // EXHAUSTS
    // ============================================================

    const exhaustGeo = new THREE.CylinderGeometry(
        0.055,
        0.055,
        0.10,
        8
    );

    exhaustGeo.rotateX(Math.PI / 2);

    add(
        exhaustGeo,
        bodyDarkMat,
        W * 0.30,
        -0.31,
        -L * 0.505
    );

    add(
        exhaustGeo.clone(),
        bodyDarkMat,
        -W * 0.30,
        -0.31,
        -L * 0.505
    );

    // ============================================================
    // FINISH
    // ============================================================

    parts.forEach(mesh => group.add(mesh));

    return {
        group,
        bodyMat
    };
}