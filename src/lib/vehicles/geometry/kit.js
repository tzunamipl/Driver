import * as THREE from 'three';

// Primitive helpers shared by the low-poly vehicle builders: each adds a
// shadow-casting mesh at (x, y, z) to `group` and returns it.

export function createKit(group) {
  const add = (geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };
  const box = (w, h, d, material, x, y, z) => add(new THREE.BoxGeometry(w, h, d), material, x, y, z);
  /** Cylinder along z. */
  const tube = (r, len, material, x, y, z, segments = 14) => add(new THREE.CylinderGeometry(r, r, len, segments).rotateX(Math.PI / 2), material, x, y, z);
  /** Open half-tube arching over a wheel (axis along x). */
  const fender = (r, width, material, x, y, z) =>
    add(new THREE.CylinderGeometry(r, r, width, 14, 1, true, 0, Math.PI).rotateZ(Math.PI / 2), material, x, y, z);
  /**
   * Side profile extruded across x: `points` are [z, y] pairs, `width` the
   * extrusion, centred on `x`. For raked windscreens, fastbacks and fins.
   */
  const profile = (points, width, material, x = 0) => {
    const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
    g.rotateY(-Math.PI / 2).translate(width / 2, 0, 0); // shape x -> z, extrusion -> -x
    return add(g, material, x, 0, 0);
  };
  /** Cone pointing along `dir` ('x', '-x', 'y', 'z', '-z'). */
  const spike = (r, len, material, x, y, z, dir) => {
    const g = new THREE.ConeGeometry(r, len, 6);
    if (dir === 'z') g.rotateX(Math.PI / 2);
    if (dir === '-z') g.rotateX(-Math.PI / 2);
    if (dir === 'x') g.rotateZ(-Math.PI / 2);
    if (dir === '-x') g.rotateZ(Math.PI / 2);
    return add(g, material, x, y, z);
  };
  return { add, box, tube, fender, profile, spike };
}
