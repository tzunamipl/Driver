// Roadside scenery for a stage's or itinerary's points, FIA style: yellow/red/beige boards
// on both sides of the road (100 m before, at, 25 m after the control), start/finish
// arches with lines, start lights, tall split flags. Also each point's gate line for
// timing. Placed once the streets around a point are loaded; anchored in lat/lon and
// repositioned every frame, so teleports and origin shifts need nothing special.
// Visual only: nothing here collides.

import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import { snapToRoad, walkRoad } from '../scenarios/roadSnap.js';
import { boardTexture, bannerTexture } from './fiaBoards.js';
import { createFireworks } from './fireworks.js';
import { createSparkles } from './sparkles.js';

const SNAP_RADIUS_M = 40;
const RESOLVE_RETRY_S = 1;
const WARNING_BOARD_M = 100; // yellow board before the control
const ZONE_END_M = 25; // beige board after it
const BOARD_SIDE_GAP_M = 1.2; // board post beyond the road edge
const BOARD_SIZE_M = 0.9;
const BOARD_HEIGHT_M = 2.1; // board centre; a type's boardHeight overrides
const LOW_BOARD_HEIGHT_M = 1;
const ARCH_TUBE_M = 0.35;
const FLAG_POLE_M = 5;
const SPLIT_FLAG_COLOR = '#ff6a00';
// Flag cloth in the wind: a wave running from the pole to the free edge, growing along it.
const FLAG_LENGTH_M = 4;
const FLAG_WIDTH_M = 0.9;
const WAVE_AMP_M = 0.35;
const WAVE_SPEED = 5.5; // rad/s
const WAVE_PER_M = 3.2; // rad per metre from the pole
const WAVE_ALONG = 0.7; // rad per metre up the flag, so it doesn't flap as one sheet
const SPARKLE_HEIGHT_M = 3; // thrown from this high at both sides of a gate without poles
const LAMPS = 5;
const LAMP_OFF = 0x222222;
const LAMP_RED = 0xff1a1a;
const LAMP_GREEN = 0x1aff3a;

// boards: symbol on the yellow/red/beige boards; zoneEnd false = no beige board; boardHeight: board centre (m).
const SCENERY = {
  timeControl: { boards: 'clock', tent: true },
  start: { arch: 'START', archColor: '#1d4fd8', lights: true, line: true },
  split: { flags: true },
  passageControl: { boards: 'PC', boardHeight: LOW_BOARD_HEIGHT_M },
  finish: { boards: 'chequered', zoneEnd: false, arch: 'FINISH', archColor: '#d71e1e', line: true },
  stop: { boards: 'STOP' },
  serviceParkIn: { boards: 'clock' },
  serviceParkOut: { boards: 'clock' },
  regroup: { boards: 'clock' },
  refuel: { boards: 'FUEL' },
  tyreFitting: { boards: 'TYRES' },
  remoteService: { boards: 'RSZ' },
  parcFerme: { boards: 'PARC FERMÉ' },
  podium: { arch: 'PODIUM', archColor: '#c08a10', line: true },
};

const postGeometry = new CylinderGeometry(0.05, 0.05, BOARD_HEIGHT_M + BOARD_SIZE_M / 2, 6);
postGeometry.translate(0, (BOARD_HEIGHT_M + BOARD_SIZE_M / 2) / 2, 0);
const poleGeometry = new CylinderGeometry(0.06, 0.06, FLAG_POLE_M, 6);
poleGeometry.translate(0, FLAG_POLE_M / 2, 0);
const boardGeometry = new PlaneGeometry(BOARD_SIZE_M, BOARD_SIZE_M);
const lampGeometry = new SphereGeometry(0.11, 10, 8);
const greyMaterial = new MeshLambertMaterial({ color: 0x8a8a8a });
const whiteMaterial = new MeshLambertMaterial({ color: 0xf2f2f2 });
const boardMaterials = new Map();

function boardMaterial(color, symbol) {
  const key = `${color}|${symbol}`;
  if (!boardMaterials.has(key)) boardMaterials.set(key, new MeshBasicMaterial({ map: boardTexture(color, symbol) }));
  return boardMaterials.get(key);
}

/** Board on a post, centred `height` up; faces local +z (towards approaching cars). */
function makeBoard(color, symbol, height = BOARD_HEIGHT_M) {
  const group = new Group();
  const post = new Mesh(postGeometry, greyMaterial);
  post.scale.y = (height + BOARD_SIZE_M / 2) / (BOARD_HEIGHT_M + BOARD_SIZE_M / 2);
  group.add(post);
  const front = new Mesh(boardGeometry, boardMaterial(color, symbol));
  front.position.set(0, height, 0.03);
  const back = new Mesh(boardGeometry, greyMaterial);
  back.position.set(0, height, 0.02);
  back.rotation.y = Math.PI;
  group.add(front, back);
  return group;
}

/** Arch over the road, spanning local x; banner faces local +z. */
function makeArch(halfSpan, text, color) {
  const group = new Group();
  const material = new MeshLambertMaterial({ color });
  group.add(new Mesh(new TorusGeometry(halfSpan, ARCH_TUBE_M, 8, 28, Math.PI), material));
  const banner = new Mesh(
    new PlaneGeometry(halfSpan * 1.1, 0.9),
    new MeshBasicMaterial({ map: bannerTexture(text, color), side: DoubleSide })
  );
  banner.position.set(0, halfSpan - 0.25, ARCH_TUBE_M + 0.02);
  group.add(banner);
  return group;
}

function makeLine(halfSpan) {
  const line = new Mesh(new BoxGeometry(halfSpan * 2, 0.04, 0.4), whiteMaterial);
  line.position.y = 0.04;
  return line;
}

function makeLights() {
  const group = new Group();
  const pillar = new Mesh(new BoxGeometry(0.4, 2.8, 0.4), new MeshLambertMaterial({ color: 0x202020 }));
  pillar.position.y = 1.4;
  group.add(pillar);
  const lamps = [];
  for (let i = 0; i < LAMPS; i++) {
    const lamp = new Mesh(lampGeometry, new MeshBasicMaterial({ color: LAMP_OFF }));
    lamp.position.set(0, 2.5 - i * 0.26, 0.22);
    group.add(lamp);
    lamps.push(lamp);
  }
  return { group, lamps };
}

function makeFlag() {
  const group = new Group();
  group.add(new Mesh(poleGeometry, greyMaterial));
  // Few segments: the ripple reads as folds, not a smooth sheet.
  const geometry = new PlaneGeometry(FLAG_LENGTH_M, FLAG_WIDTH_M, 5, 2);
  const flag = new Mesh(geometry, new MeshLambertMaterial({ map: bannerTexture('SPLIT', SPLIT_FLAG_COLOR), side: DoubleSide }));
  // Tall feather flag: banner turned upright beside the pole (its local +y edge on the pole).
  flag.rotation.z = Math.PI / 2;
  flag.position.set(0.05 + FLAG_WIDTH_M / 2, FLAG_POLE_M - 2.1, 0);
  group.add(flag);
  group.userData.cloth = { geometry, base: geometry.attributes.position.array.slice(), phase: Math.random() * Math.PI * 2 };
  return group;
}

/** Ripples a flag's cloth (makeFlag) for time `t`: still at the pole, most at the free edge. */
function waveFlag({ geometry, base, phase }, t) {
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = base[i * 3];
    const fromPole = FLAG_WIDTH_M / 2 - base[i * 3 + 1];
    const z = Math.sin(t * WAVE_SPEED + phase - fromPole * WAVE_PER_M + x * WAVE_ALONG) * WAVE_AMP_M * (fromPole / FLAG_WIDTH_M);
    pos.setZ(i, z);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals(); // folds shade with the light
}

function makeTent() {
  const group = new Group();
  const roof = new Mesh(new BoxGeometry(2.6, 0.25, 2.6), whiteMaterial);
  roof.position.y = 2.3;
  group.add(roof);
  for (const [x, z] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) {
    const leg = new Mesh(new CylinderGeometry(0.04, 0.04, 2.3, 5), greyMaterial);
    leg.position.set(x, 1.15, z);
    group.add(leg);
  }
  return group;
}

/** Group yaw so local +z faces back along travel (dirX, dirZ) and local +x is its right. */
const yawFacing = (dirX, dirZ) => Math.atan2(-dirX, -dirZ);

function disposeGroup(group) {
  group.traverse((obj) => {
    if (obj.geometry && ![postGeometry, poleGeometry, boardGeometry, lampGeometry].includes(obj.geometry)) obj.geometry.dispose();
    if (obj.material && obj.material !== greyMaterial && obj.material !== whiteMaterial && ![...boardMaterials.values()].includes(obj.material)) {
      obj.material.dispose();
    }
  });
}

/** @param {{onSparkle?: () => void}} deps - onSparkle: sound hook, once per sparkle(). */
export function createControlScenery({ scene, streets, terrain, viewFrame, onSparkle }) {
  const fireworks = createFireworks(scene);
  const sparkles = createSparkles(scene);
  /** @type {{point: object, travel: {x: number, z: number} | null, resolved: object | null, retryAt: number}[]} */
  let entries = [];
  let time = 0;

  /** Rough travel direction at point i: towards the next point, else away from the previous one. */
  function travelHint(points, i) {
    const here = viewFrame.fromLatLon(points[i].lat, points[i].lon);
    const other = points[i + 1] ?? points[i - 1];
    if (!other) return null;
    const there = viewFrame.fromLatLon(other.lat, other.lon);
    const sign = points[i + 1] ? 1 : -1;
    return { x: (there.x - here.x) * sign, z: (there.z - here.z) * sign };
  }

  function anchor(group, x, z, dirX, dirZ) {
    scene.add(group);
    group.visible = false;
    return { group, ...viewFrame.toLatLon(x, z), yaw: yawFacing(dirX, dirZ) };
  }

  /** Builds the point's scenery around its snapped road; null while the streets there aren't loaded. */
  function resolve(entry) {
    const { point } = entry;
    const at = viewFrame.fromLatLon(point.lat, point.lon);
    const snap = snapToRoad(streets, at.x, at.z, SNAP_RADIUS_M);
    if (!snap) return null;
    const hint = travelHint(entry.points, entry.index) ?? { x: snap.dirX, z: snap.dirZ };
    const sign = snap.dirX * hint.x + snap.dirZ * hint.z >= 0 ? 1 : -1;
    const dirX = snap.dirX * sign;
    const dirZ = snap.dirZ * sign;
    const halfSpan = Math.max(point.width ?? 0, snap.roadWidth) / 2 + BOARD_SIDE_GAP_M;
    const def = SCENERY[point.type] ?? {};
    const objects = [];
    let lamps = null;
    const flags = [];
    const poleTops = []; // { object, height }: where sparkles come from

    // Right of travel is local +x: (-dirZ, dirX).
    const side = (x, z, offset) => ({ x: x - dirZ * offset, z: z + dirX * offset });
    if (def.boards) {
      const spots = [['yellow', -WARNING_BOARD_M], ['red', 0]];
      if (def.zoneEnd !== false) spots.push(['beige', ZONE_END_M]);
      for (const [color, along] of spots) {
        const p = along === 0 ? { x: snap.x, z: snap.z, dirX, dirZ } : walkRoad(streets, snap, along * sign);
        // walkRoad gives the walking direction: backwards for boards before the control.
        const pDirX = along === 0 ? dirX : p.dirX * Math.sign(along);
        const pDirZ = along === 0 ? dirZ : p.dirZ * Math.sign(along);
        const offset = along === 0 ? halfSpan : snap.roadWidth / 2 + BOARD_SIDE_GAP_M;
        for (const s of [-1, 1]) {
          const q = { x: p.x - pDirZ * offset * s, z: p.z + pDirX * offset * s };
          const object = anchor(makeBoard(color, def.boards, def.boardHeight), q.x, q.z, pDirX, pDirZ);
          objects.push(object);
          if (along === 0) poleTops.push({ object, height: (def.boardHeight ?? BOARD_HEIGHT_M) + BOARD_SIZE_M / 2 });
        }
      }
    }
    if (def.arch) objects.push(anchor(makeArch(halfSpan, def.arch, def.archColor), snap.x, snap.z, dirX, dirZ));
    if (def.line) objects.push(anchor(makeLine(halfSpan - BOARD_SIDE_GAP_M), snap.x, snap.z, dirX, dirZ));
    if (def.lights) {
      const lights = makeLights();
      const q = side(snap.x, snap.z, halfSpan + 1);
      objects.push(anchor(lights.group, q.x, q.z, dirX, dirZ));
      lamps = lights.lamps;
    }
    if (def.tent) {
      const q = side(snap.x, snap.z, -(halfSpan + 2.5));
      objects.push(anchor(makeTent(), q.x, q.z, dirX, dirZ));
    }
    if (def.flags) {
      for (const s of [-1, 1]) {
        const q = side(snap.x, snap.z, s * (halfSpan + 0.5));
        const object = anchor(makeFlag(), q.x, q.z, dirX, dirZ);
        objects.push(object);
        flags.push(object);
        poleTops.push({ object, height: FLAG_POLE_M });
      }
    }
    return { dirX, dirZ, halfWidth: (point.width ?? snap.roadWidth) / 2, objects, lamps, flags, poleTops };
  }

  function clear() {
    for (const entry of entries) {
      for (const { group } of entry.resolved?.objects ?? []) {
        scene.remove(group);
        disposeGroup(group);
      }
    }
    entries = [];
  }

  return {
    /** Shows scenery for these points (driving order), replacing any previous set. */
    setPoints(points) {
      clear();
      entries = points.map((point, index) => ({ point, points, index, resolved: null, retryAt: 0 }));
    },
    clear,

    /**
     * Point i's gate across the road in world metres: centre, travel direction, half width;
     * dir is null until the road there is known (then only distance can be checked).
     */
    getGate(i) {
      const entry = entries[i];
      if (!entry) return null;
      const { x, z } = viewFrame.fromLatLon(entry.point.lat, entry.point.lon);
      const r = entry.resolved;
      return { x, z, dirX: r?.dirX ?? null, dirZ: r?.dirZ ?? null, halfWidth: r?.halfWidth ?? (entry.point.width ?? 10) / 2 };
    },

    /** Start lights at point i: `red` lamps lit (0..5), or all green. */
    setLights(i, red, green = false) {
      const lamps = entries[i]?.resolved?.lamps;
      if (!lamps) return;
      lamps.forEach((lamp, n) => lamp.material.color.setHex(green ? LAMP_GREEN : n < red ? LAMP_RED : LAMP_OFF));
    },

    /** Fireworks from point i's flags (or the point itself). */
    celebrate(i) {
      const entry = entries[i];
      if (!entry) return;
      const spots = entry.resolved?.flags.length ? entry.resolved.flags.map((f) => f.group.position) : [];
      if (!spots.length) {
        const { x, z } = viewFrame.fromLatLon(entry.point.lat, entry.point.lon);
        spots.push({ x, y: terrain.surfaceHeightAt(x, z) ?? 0, z });
      }
      for (const p of spots) fireworks.fire(p.x, p.y + FLAG_POLE_M, p.z);
    },

    /** Sparkles from the tops of point i's poles (flags, control boards), else from both sides of its gate. */
    sparkle(i) {
      onSparkle?.();
      const poleTops = entries[i]?.resolved?.poleTops ?? [];
      if (poleTops.length) {
        for (const { object, height } of poleTops) {
          const { x, y, z } = object.group.position;
          sparkles.throw(x, y + height, z);
        }
        return;
      }
      const gate = this.getGate(i);
      if (!gate) return;
      // Across the road: perpendicular to travel, or along x while the road is unknown.
      const ax = gate.dirX == null ? 1 : -gate.dirZ;
      const az = gate.dirX == null ? 0 : gate.dirX;
      for (const s of [-1, 1]) {
        const x = gate.x + ax * s * (gate.halfWidth + 1);
        const z = gate.z + az * s * (gate.halfWidth + 1);
        const y = terrain.surfaceHeightAt(x, z);
        if (y != null) sparkles.throw(x, y + SPARKLE_HEIGHT_M, z);
      }
    },

    update(dt) {
      time += dt;
      for (const entry of entries) {
        if (!entry.resolved && time >= entry.retryAt) {
          entry.resolved = resolve(entry);
          entry.retryAt = time + RESOLVE_RETRY_S;
        }
        for (const object of entry.resolved?.objects ?? []) {
          const { x, z } = viewFrame.fromLatLon(object.lat, object.lon);
          const y = terrain.surfaceHeightAt(x, z);
          object.group.visible = y != null;
          if (y == null) continue;
          object.group.position.set(x, y, z);
          object.group.rotation.y = object.yaw;
        }
        for (const flag of entry.resolved?.flags ?? []) if (flag.group.visible) waveFlag(flag.group.userData.cloth, time);
      }
      fireworks.update(dt);
      sparkles.update(dt);
    },

    shiftOrigin(dx, dz) {
      fireworks.shiftOrigin(dx, dz);
      sparkles.shiftOrigin(dx, dz);
    },
  };
}
