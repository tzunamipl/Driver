import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { DEFAULT_BODY_COLOR } from '../../../config.js';

// Shared low-poly 1993-2000 Subaru Impreza body; gl.js (wagon) and gc8.js
// (sedan) supply the rear profile and details. Modelled in metres for a
// 1.8 x 4 m chassis and scaled to the requested size; wheels sit at z = ±1.3.
// Overhangs run past the 4 m chassis to keep the real car's long, low stance.

const REF_WIDTH = 1.8;
const REF_LENGTH = 4;

const ARCH_Z = 1.3;
const ARCH_Y = -0.34;
const ARCH_R = 0.38;

// Piecewise-linear profiles as [z, value], z descending (nose → tail).
const FRONT_TOP = [[2.22, -0.02], [2.17, 0.05], [2.05, 0.1], [1.6, 0.16], [0.8, 0.24]];
const BODY_BOTTOM = [
    [2.22, -0.22], [2.17, -0.32], [2.05, -0.34], [-2.05, -0.34], [-2.15, -0.3], [-2.17, -0.24],
];
const BODY_HALF_WIDTH = [
    [2.22, 0.76], [2.15, 0.84], [1.9, 0.9], [-1.9, 0.9], [-2.12, 0.84], [-2.17, 0.8],
];

// Right headlight as [bottom, top] columns sitting just proud of the nose:
// narrow inner tip, taller outer end wrapping round the corner onto the side.
const HEADLIGHT = [
    [[0.28, -0.025, 2.245], [0.29, 0.045, 2.2]],
    [[0.5, -0.05, 2.245], [0.5, 0.055, 2.197]],
    [[0.68, -0.07, 2.245], [0.71, 0.06, 2.195]],
    [[0.795, -0.065, 2.215], [0.8, 0.035, 2.19]],
    [[0.875, -0.045, 2.11], [0.87, 0.035, 2.1]],
];
// Hexagonal grille folded over the nose edge, wider at the top.
const GRILLE = [
    [[-0.19, -0.07, 2.24], [-0.27, -0.02, 2.24], [-0.25, 0.04, 2.2]],
    [[0.19, -0.07, 2.24], [0.27, -0.02, 2.24], [0.25, 0.04, 2.2]],
];

export function lerpTable(table, z) {
    if (z >= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
        const [z1, v1] = table[i];
        if (z >= z1) {
            const [z0, v0] = table[i - 1];
            return v1 + (v0 - v1) * (z - z1) / (z0 - z1);
        }
    }
    return table[table.length - 1][1];
}

/**
 * Lofts rings (one per station, all with the same point count) into a
 * flat-shaded shell with end caps. Rings must run clockwise seen from +z.
 */
function loft(rings, segmentGroup = () => 0) {
    const groups = [[], []];
    const tri = (g, a, b, c) => groups[g].push(...a, ...b, ...c);
    const n = rings[0].length;
    for (let i = 0; i < rings.length - 1; i++) {
        const r0 = rings[i];
        const r1 = rings[i + 1];
        for (let j = 0; j < n; j++) {
            const k = (j + 1) % n;
            const g = segmentGroup(j);
            tri(g, r0[j], r0[k], r1[k]);
            tri(g, r0[j], r1[k], r1[j]);
        }
    }
    const cap = (ring, front) => {
        const c = [0, 1, 2].map((a) => ring.reduce((s, p) => s + p[a], 0) / n);
        for (let j = 0; j < n; j++) {
            const k = (j + 1) % n;
            if (front) tri(0, c, ring[k], ring[j]);
            else tri(0, c, ring[j], ring[k]);
        }
    };
    cap(rings[0], true);
    cap(rings[rings.length - 1], false);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([...groups[0], ...groups[1]], 3));
    geometry.addGroup(0, groups[0].length / 3, 0);
    geometry.addGroup(groups[0].length / 3, groups[1].length / 3, 1);
    geometry.computeVertexNormals();
    return geometry;
}

function lowerBodyGeometry(bodyTop) {
    const arch = (cz) => Array.from({ length: 5 }, (_, k) => {
        const t = (k / 4) * Math.PI;
        return { z: cz + ARCH_R * Math.cos(t), yb: ARCH_Y + ARCH_R * Math.sin(t) };
    });
    const stations = [
        ...[2.22, 2.17, 2.05].map((z) => ({ z })),
        ...arch(ARCH_Z),
        ...arch(-ARCH_Z),
        ...[-2.05, -2.12, -2.17].map((z) => ({ z })),
    ];
    const rings = stations.map(({ z, yb = lerpTable(BODY_BOTTOM, z) }) => {
        const yt = lerpTable(bodyTop, z);
        const w = lerpTable(BODY_HALF_WIDTH, z);
        const sh = Math.min(0.07, (yt - yb) * 0.35);
        return [
            [-w, yb], [-w, yt - sh], [-w + 0.06, yt],
            [w - 0.06, yt], [w, yt - sh], [w, yb],
        ].map(([x, y]) => [x, y, z]);
    });
    // Last segment is the underside / wheel-well ceiling.
    return loft(rings, (j) => (j === 5 ? 1 : 0));
}

/**
 * style:
 *   rearTop       body top line aft of the windshield base, [z, y] descending
 *   roofTail(belt) roof line aft of the windshield header, ending at the belt
 *   rearPinchZ    where the greenhouse starts narrowing toward the tail
 *   roofEndZ      back edge of the roof panel
 *   rearPanel(roof, belt)  body-colour rear pillar outline, [z, y]
 *   rearFrame     [z0, z1] segments of the body-colour rear window frame
 *   blackPillars  front-top z of each blacked-out pillar
 *   sealEndZ      where the black belt seal stops
 *   frontPlate    optional [x, y] of the front number plate (default centred)
 *   decorate(kit) variant-specific details
 */
export function buildImprezaBody(chassisWidth, chassisLength, color = DEFAULT_BODY_COLOR, style) {
    const group = new THREE.Group();
    const body = new THREE.Group();
    body.scale.set(chassisWidth / REF_WIDTH, 1, chassisLength / REF_LENGTH);
    group.add(body);

    const bodyTop = [...FRONT_TOP, ...style.rearTop];
    const belt = (z) => lerpTable(bodyTop, z) - 0.01;
    const roofTable = [[0.8, belt(0.8) + 0.005], [-0.1, 0.74], [-0.25, 0.76], ...style.roofTail(belt)];
    const roof = (z) => lerpTable(roofTable, z);
    const tailZ = roofTable[roofTable.length - 1][0];

    /** Greenhouse half width: tumblehome with height, pinched toward the tail. */
    const cabinHalfWidth = (y, z) => {
        const t = THREE.MathUtils.clamp((y - 0.26) / 0.5, 0, 1);
        const pinch = Math.min(1, Math.max(0, (style.rearPinchZ - z) / (style.rearPinchZ - tailZ)));
        return (0.8 - 0.14 * t) * (1 - 0.09 * pinch);
    };

    const materials = {
        body: createPaintMaterial(color, { metalness: 0.35, roughness: 0.5, flatShading: true }),
        glass: createGlossyMaterial({ color: 0x18222c, metalness: 0.5, roughness: 0.15, flatShading: true }),
        trim: new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.8 }),
        plate: new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 }),
        light: createGlossyMaterial({ color: 0xfff0c8, emissive: 0x403418, roughness: 0.2 }),
        tail: createGlossyMaterial({ color: 0x9a1016, emissive: 0x2a0000, roughness: 0.3 }),
    };
    const { body: bodyMat, glass: glassMat, trim: trimMat } = materials;

    const add = (geometry, material, x = 0, y = 0, z = 0) => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(x, y, z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        body.add(mesh);
        return mesh;
    };
    const box = (w, h, d, material, x, y, z) => add(new THREE.BoxGeometry(w, h, d), material, x, y, z);

    /** Thin box running from a to b. */
    const beam = (a, b, width, thickness, material) => {
        const from = new THREE.Vector3(...a);
        const to = new THREE.Vector3(...b);
        const mesh = box(width, thickness, from.distanceTo(to), material);
        mesh.position.copy(from).add(to).multiplyScalar(0.5);
        mesh.lookAt(to);
        return mesh;
    };

    /**
     * Thick panel through columns of [x, y, z] points (bottom → top); columns
     * run left → right seen from outside. Sides sink `depth` into the body.
     */
    const ribbon = (columns, material, depth = 0.05) => {
        const at = (i, j) => new THREE.Vector3(...columns[i][j]);
        const back = columns.map((column, i) => column.map((_, j) => {
            const across = at(Math.min(i + 1, columns.length - 1), j).sub(at(Math.max(i - 1, 0), j));
            const up = at(i, Math.min(j + 1, column.length - 1)).sub(at(i, Math.max(j - 1, 0)));
            const normal = across.cross(up).normalize();
            return at(i, j).addScaledVector(normal, -depth).toArray();
        }));
        const positions = [];
        const quad = (a, b, c, d) => positions.push(...a, ...b, ...c, ...a, ...c, ...d);
        const rows = columns[0].length;
        for (let i = 0; i < columns.length - 1; i++) {
            for (let j = 0; j < rows - 1; j++) {
                quad(columns[i][j], columns[i + 1][j], columns[i + 1][j + 1], columns[i][j + 1]);
            }
            quad(back[i][0], back[i + 1][0], columns[i + 1][0], columns[i][0]);
            quad(columns[i][rows - 1], columns[i + 1][rows - 1], back[i + 1][rows - 1], back[i][rows - 1]);
        }
        const last = columns.length - 1;
        for (let j = 0; j < rows - 1; j++) {
            quad(back[0][j], columns[0][j], columns[0][j + 1], back[0][j + 1]);
            quad(columns[last][j], back[last][j], back[last][j + 1], columns[last][j + 1]);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.computeVertexNormals();
        return add(geometry, material);
    };

    /** Flat [z, y] outline laid onto both greenhouse sides. */
    const cabinPanel = (outline, material, offset = 0.006) => {
        const geometry = new THREE.ShapeGeometry(new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(z, y))));
        const pos = geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            const z = pos.getX(i);
            const y = pos.getY(i);
            pos.setXYZ(i, -(cabinHalfWidth(y, z) + offset), y, z);
        }
        geometry.computeVertexNormals();
        add(geometry, material);
        // Negative scale mirrors to the right side; three.js flips the winding for it.
        add(geometry, material).scale.x = -1;
    };

    // Shell
    add(lowerBodyGeometry(bodyTop), [bodyMat, trimMat]);
    const cabinRings = roofTable.map(([z, yt]) => {
        const yb = belt(z);
        const wb = cabinHalfWidth(yb, z);
        const wt = cabinHalfWidth(yt, z);
        return [[-wb, yb, z], [-wt, yt, z], [wt, yt, z], [wb, yb, z]];
    });
    add(loft(cabinRings), glassMat);

    // Roof and pillars
    const roofFront = -0.12;
    const headerZ = style.roofEndZ + 0.01;
    box(2 * cabinHalfWidth(0.76, 0) + 0.03, 0.035, roofFront - style.roofEndZ, bodyMat,
        0, 0.775, (roofFront + style.roofEndZ) / 2);
    box(2 * cabinHalfWidth(0.74, headerZ) + 0.02, 0.04, 0.1, bodyMat, 0, roof(headerZ) + 0.025, headerZ);
    const end = style.roofEndZ;
    cabinPanel([[-0.08, roof(-0.08) + 0.004], [end, roof(end) + 0.004], [end + 0.04, roof(end + 0.04) - 0.05], [-0.14, roof(-0.14) - 0.05]], bodyMat, 0.007);
    cabinPanel([[0.8, belt(0.8)], [-0.1, roof(-0.1)], [-0.18, roof(-0.18) - 0.05], [0.69, belt(0.69)]], bodyMat);
    for (const z of style.blackPillars) {
        cabinPanel([[z, roof(z) - 0.045], [z - 0.1, roof(z - 0.1) - 0.045], [z - 0.13, belt(z - 0.13)], [z - 0.03, belt(z - 0.03)]], trimMat);
    }
    cabinPanel(style.rearPanel(roof, belt), bodyMat);
    const seal = style.sealEndZ;
    cabinPanel([[0.69, belt(0.69) + 0.008], [0.67, belt(0.67) + 0.04], [seal, belt(seal) + 0.04], [seal, belt(seal) + 0.008]], trimMat, 0.008);

    for (const side of [-1, 1]) {
        const pillar = (z0, z1, width) => beam(
            [side * (cabinHalfWidth(roof(z0), z0) + 0.005), roof(z0), z0],
            [side * (cabinHalfWidth(roof(z1), z1) + 0.005), roof(z1), z1],
            width, 0.035, bodyMat
        );
        pillar(0.8, -0.12, 0.07);
        for (const [z0, z1] of style.rearFrame) pillar(z0, z1, 0.09);

        box(0.02, 0.05, 1.76, trimMat, side * 0.905, -0.06, 0); // side rubbing strip
        box(0.08, 0.11, 0.15, trimMat, side * 0.9, 0.37, 0.68); // mirror
    }

    ribbon(HEADLIGHT, materials.light);
    ribbon(HEADLIGHT.map((column) => column.map(([x, y, z]) => [-x, y, z])).reverse(), materials.light);
    ribbon(GRILLE, trimMat);
    box(0.62, 0.06, 0.03, trimMat, 0, -0.27, 2.2);                   // lower intake
    const [plateX, plateY] = style.frontPlate ?? [0, -0.12];
    box(0.52, 0.11, 0.012, materials.plate, plateX, plateY, 2.23);

    style.decorate({ add, box, beam, materials, roof, belt });

    return { group, bodyMat };
}
