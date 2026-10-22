// Roadside scenery for a whole itinerary's points, FIA style: yellow/red/beige boards
// on both sides of the road (100 m before, at, 25 m after the control), start/finish
// arches with lines, start lights, tall split flags (smaller ones for passage controls),
// per-type props (zoneProps.js). Also each point's gate line for timing, indexed from the
// active item. Placed once the streets around a point are loaded; anchored in lat/lon and
// repositioned every frame, so teleports and origin shifts need nothing special.
// Visual only: nothing here collides.

import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import { controlFrame } from '../scenarios/roadSnap.js';
import { boardTexture, bannerTexture } from './fiaBoards.js';
import { createFireworks } from './fireworks.js';
import { createSparkles } from './sparkles.js';
import * as props from './zoneProps.js';
import { bakeProps } from './zoneProps.js';

const SNAP_RADIUS_M = 40;
const RESOLVE_RETRY_S = 1;
const WARNING_BOARD_M = 100; // yellow board before the control
const ZONE_END_M = 25; // beige board after it
// Poles stand on the asphalt, inside the road edge, so they read as framing the road.
const POLE_INSET_M = 1;
const MIN_POLE_HALF_SPAN_M = 2; // narrow roads: keep a car's width between the poles
const BOARD_SIZE_M = 0.9;
const BOARD_HEIGHT_M = 2.1; // board centre; a type's boardHeight overrides
const ARCH_TUBE_M = 0.35;
const FLAG_POLE_M = 5;
// Flag cloth in the wind: a wave running from the pole to the free edge, growing along it.
const FLAG_LENGTH_M = 4;
const FLAG_WIDTH_M = 0.9;
const FLAG_IDLE_COLOR = '#8a8a8a';
const LIT_AHEAD = 2; // the next point and the one after have flags in colour and glowing dots on their poles
const BOARD_DOT_COLOR = '#ffc400';
const DOT_RADIUS_M = 0.12;
const DOT_PULSE_HZ = 1.5;
const DOT_SPIN = 6; // rad/s round the pole
// Further than this from the car the dots grow with distance, so they stay visible far ahead.
const DOT_GROW_FROM_M = 40;
const DOT_MAX_SCALE = 15;
const WAVE_AMP_M = 0.35;
const WAVE_SPEED = 5.5; // rad/s
const WAVE_PER_M = 3.2; // rad per metre from the pole
const WAVE_ALONG = 0.7; // rad per metre up the flag, so it doesn't flap as one sheet
const VIEW_RANGE_M = 2500; // points further from the car are hidden and not resolved
const PROPS_GAP_M = 1.5; // zone props beyond the control's boards
const SPARKLE_HEIGHT_M = 3; // thrown from this high at both sides of a gate without poles
const LAMPS = 5;
const LAMP_OFF = 0x222222;
const LAMP_RED = 0xff1a1a;
const LAMP_GREEN = 0x1aff3a;

// boards: symbol on the yellow/red/beige boards; zoneEnd false = no beige board; boardHeight: board centre (m);
// bothWays: approachable from either side: a yellow board 100 m out each way, a two-faced red one, no zone end;
// flags: feather flag on each side of the road (text, colour; pole height and cloth length / width in m),
// in colour only while it's the next point to pass, grey otherwise;
// props: zoneProps.js builder set beside the road (right of travel, or left with propsLeft).
const SCENERY = {
  timeControl: { boards: 'clock', props: props.makeMarshalTent, propsLeft: true },
  start: { arch: 'START', archColor: '#1d4fd8', lights: true, line: true, props: props.makeTimingHut, propsLeft: true },
  split: { flags: { text: 'SPLIT', color: '#ff6a00' }, props: props.makeSplitBox },
  passageControl: { flags: { text: 'PC', color: '#7b3fe0', pole: 2.5, length: 1.5, width: 0.5 }, props: props.makePassageProps, propsLeft: true },
  finish: { boards: 'chequered', zoneEnd: false, arch: 'FINISH', archColor: '#d71e1e', line: true, props: props.makeTimekeeperTent, propsLeft: true },
  stop: { boards: 'STOP', props: props.makeMarshalTent, propsLeft: true },
  serviceParkIn: { boards: 'clock', props: props.makeServiceGate },
  serviceParkOut: { boards: 'clock', props: props.makeServiceGate },
  regroup: { boards: 'clock', props: props.makeRegroupProps },
  refuel: { boards: 'FUEL', bothWays: true, props: props.makeRefuelProps },
  tyreFitting: { boards: 'TYRES', bothWays: true, props: props.makeTyreProps },
  remoteService: { boards: 'RSZ', props: props.makeRemoteServiceProps },
  parcFerme: { boards: 'PARC FERMÉ', props: props.makeParcFermeProps },
  podium: { arch: 'PODIUM', archColor: '#c08a10', line: true, props: props.makePodiumProps },
  base: { props: props.makeBaseTent, propsLeft: true },
};

const postGeometry = new CylinderGeometry(0.05, 0.05, BOARD_HEIGHT_M + BOARD_SIZE_M / 2, 6);
postGeometry.translate(0, (BOARD_HEIGHT_M + BOARD_SIZE_M / 2) / 2, 0);
const poleGeometry = new CylinderGeometry(0.06, 0.06, FLAG_POLE_M, 6);
poleGeometry.translate(0, FLAG_POLE_M / 2, 0);
const boardGeometry = new PlaneGeometry(BOARD_SIZE_M, BOARD_SIZE_M);
const dotGeometry = new SphereGeometry(DOT_RADIUS_M, 10, 8);
dotGeometry.userData.shared = true;
const lampGeometry = new SphereGeometry(0.11, 10, 8);
const greyMaterial = new MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.6 });
const whiteMaterial = new MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });
const boardMaterials = new Map();

/**
 * The point type's control boards as [colour, metres along travel, facing]: facing 1 =
 * towards traffic in driving order, -1 = the other way. Empty for types without boards.
 */
export function boardSpots(type) {
  const def = SCENERY[type];
  if (!def?.boards) return [];
  const spots = [['yellow', -WARNING_BOARD_M, 1], ['red', 0, 1]];
  if (def.bothWays) spots.push(['yellow', WARNING_BOARD_M, -1]);
  else if (def.zoneEnd !== false) spots.push(['beige', ZONE_END_M, 1]);
  return spots;
}

function boardMaterial(color, symbol) {
  const key = `${color}|${symbol}`;
  if (!boardMaterials.has(key)) boardMaterials.set(key, new MeshStandardMaterial({ map: boardTexture(color, symbol), roughness: 0.4 }));
  return boardMaterials.get(key);
}

/** Board on a post, centred `height` up; faces local +z (towards approaching cars). */
function makeBoard(color, symbol, height = BOARD_HEIGHT_M, twoFaced = false) {
  const group = new Group();
  const post = new Mesh(postGeometry, greyMaterial);
  post.scale.y = (height + BOARD_SIZE_M / 2) / (BOARD_HEIGHT_M + BOARD_SIZE_M / 2);
  group.add(post);
  const front = new Mesh(boardGeometry, boardMaterial(color, symbol));
  front.position.set(0, height, 0.03);
  const back = new Mesh(boardGeometry, twoFaced ? front.material : greyMaterial);
  back.position.set(0, height, 0.02);
  back.rotation.y = Math.PI;
  group.add(front, back);
  return group;
}

/** Distance from the road's centre line to a gate's poles. */
const poleHalfSpan = (roadHalf) => Math.max(roadHalf - POLE_INSET_M, MIN_POLE_HALF_SPAN_M);

/** Arch over the road, spanning local x; banner faces local +z. */
function makeArch(halfSpan, text, color) {
  const group = new Group();
  const material = new MeshStandardMaterial({ color, roughness: 0.5 });
  group.add(new Mesh(new TorusGeometry(halfSpan, ARCH_TUBE_M, 6, 12, Math.PI), material));
  const banner = new Mesh(
    new PlaneGeometry(halfSpan * 1.1, 0.9),
    new MeshStandardMaterial({ map: bannerTexture(text, color), side: DoubleSide, roughness: 0.6 })
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
  const pillar = new Mesh(new BoxGeometry(0.4, 2.8, 0.4), new MeshStandardMaterial({ color: 0x202020, roughness: 0.6 }));
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

const flagMaterials = new Map();

function flagMaterial(text, color) {
  const key = `${text}|${color}`;
  if (!flagMaterials.has(key)) {
    const material = new MeshStandardMaterial({ map: bannerTexture(text, color), side: DoubleSide, roughness: 0.7 });
    material.userData.shared = true;
    flagMaterials.set(key, material);
  }
  return flagMaterials.get(key);
}

const dotMaterials = new Map();

// Unlit and outside tone mapping: reads as a glowing light even at night.
function dotMaterial(color) {
  if (!dotMaterials.has(color)) {
    const material = new MeshBasicMaterial({ color, toneMapped: false });
    material.userData.shared = true;
    dotMaterials.set(color, material);
  }
  return dotMaterials.get(color);
}

/** Glowing dots in a ring round a pole top at `height`, shown while the point is lit. */
function makeDots(color, height) {
  const dots = new Group();
  for (let n = 0; n < 4; n++) {
    const a = (n / 4) * Math.PI * 2;
    const dot = new Mesh(dotGeometry, n % 2 ? dotMaterial('#ffffff') : dotMaterial(color));
    dot.position.set(Math.cos(a) * 0.18, 0, Math.sin(a) * 0.18);
    dots.add(dot);
  }
  dots.add(new Mesh(dotGeometry, dotMaterial('#ffffff')));
  dots.userData.height = height;
  dots.visible = false;
  return dots;
}

function makeFlag({ text, color, pole = FLAG_POLE_M, length = FLAG_LENGTH_M, width = FLAG_WIDTH_M }) {
  const group = new Group();
  const poleMesh = new Mesh(poleGeometry, greyMaterial);
  poleMesh.scale.y = pole / FLAG_POLE_M;
  group.add(poleMesh);
  // Few segments: the ripple reads as folds, not a smooth sheet.
  const geometry = new PlaneGeometry(length, width, 5, 2);
  const flag = new Mesh(geometry, flagMaterial(text, FLAG_IDLE_COLOR));
  // Tall feather flag: banner turned upright beside the pole (its local +y edge on the pole).
  flag.rotation.z = Math.PI / 2;
  flag.position.set(0.05 + width / 2, pole - 0.1 - length / 2, 0);
  group.add(flag);
  const dots = makeDots(color, pole);
  group.add(dots);
  group.userData.cloth = { geometry, width, base: geometry.attributes.position.array.slice(), phase: Math.random() * Math.PI * 2 };
  group.userData.dots = dots;
  group.userData.setLit = (lit) => {
    flag.material = flagMaterial(text, lit ? color : FLAG_IDLE_COLOR);
    dots.visible = lit;
  };
  return group;
}

/** Ripples a flag's cloth (makeFlag) for time `t`: still at the pole, most at the free edge. */
function waveFlag({ geometry, width, base, phase }, t) {
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = base[i * 3];
    const fromPole = width / 2 - base[i * 3 + 1];
    const z = Math.sin(t * WAVE_SPEED + phase - fromPole * WAVE_PER_M + x * WAVE_ALONG) * WAVE_AMP_M * (fromPole / FLAG_WIDTH_M);
    pos.setZ(i, z);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals(); // folds shade with the light
}

/** Group yaw so local +z faces back along travel (dirX, dirZ) and local +x is its right. */
const yawFacing = (dirX, dirZ) => Math.atan2(-dirX, -dirZ);

function disposeGroup(group) {
  group.traverse((obj) => {
    if (obj.geometry && !obj.geometry.userData.shared && ![postGeometry, poleGeometry, boardGeometry, lampGeometry].includes(obj.geometry)) obj.geometry.dispose();
    if (obj.material && !obj.material.userData.shared && obj.material !== greyMaterial && obj.material !== whiteMaterial && ![...boardMaterials.values()].includes(obj.material)) {
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
  let active = 0; // entries index of the active item's first point
  let lit = -1; // entries index of the first of LIT_AHEAD points whose flags are in colour
  let baseEntry = null; // rally base: shown for the whole rally, not one of the indexed points
  let time = 0;

  const isLit = (index) => lit >= 0 && index >= lit && index < lit + LIT_AHEAD;
  const neighbour = (points, i) => (points[i] ? viewFrame.fromLatLon(points[i].lat, points[i].lon) : null);

  function anchor(group, x, z, dirX, dirZ) {
    group.traverse((obj) => (obj.castShadow = true));
    scene.add(group);
    group.visible = false;
    return { group, ...viewFrame.toLatLon(x, z), yaw: yawFacing(dirX, dirZ) };
  }

  /** Builds the point's scenery around its road (or heading); null while the streets there aren't loaded. */
  function resolve(entry) {
    const { point } = entry;
    const at = viewFrame.fromLatLon(point.lat, point.lon);
    // Facing follows the driving order: from the previous point towards the next one.
    const frame = controlFrame(streets, at.x, at.z, point, neighbour(entry.points, entry.index - 1), neighbour(entry.points, entry.index + 1), SNAP_RADIUS_M);
    if (!frame) return null;
    const { dirX, dirZ } = frame;
    const roadWidth = frame.roadWidth ?? point.width ?? 0;
    const roadHalf = Math.max(point.width ?? 0, roadWidth) / 2;
    const halfSpan = poleHalfSpan(roadHalf);
    const def = SCENERY[point.type] ?? {};
    const objects = [];
    let lamps = null;
    const flags = [];
    const lit = []; // objects with userData.setLit / dots: flags and the control boards
    const poleTops = []; // { object, height }: where sparkles come from

    // Right of travel is local +x: (-dirZ, dirX).
    const side = (x, z, offset) => ({ x: x - dirZ * offset, z: z + dirX * offset });
    if (def.boards) {
      for (const [color, along, facing] of boardSpots(point.type)) {
        const p = along === 0 ? frame : frame.walk(along);
        const pDirX = p.dirX * facing;
        const pDirZ = p.dirZ * facing;
        const offset = along === 0 ? halfSpan : poleHalfSpan(roadWidth / 2);
        for (const s of [-1, 1]) {
          const q = { x: p.x - pDirZ * offset * s, z: p.z + pDirX * offset * s };
          const object = anchor(makeBoard(color, def.boards, def.boardHeight, def.bothWays && along === 0), q.x, q.z, pDirX, pDirZ);
          objects.push(object);
          if (along === 0) {
            const height = (def.boardHeight ?? BOARD_HEIGHT_M) + BOARD_SIZE_M / 2;
            const dots = makeDots(BOARD_DOT_COLOR, height);
            object.group.add(dots);
            object.group.userData.dots = dots;
            object.group.userData.setLit = (on) => (dots.visible = on);
            object.group.userData.setLit(isLit(entry.index));
            lit.push(object);
            poleTops.push({ object, height });
          }
        }
      }
    }
    if (def.arch) objects.push(anchor(makeArch(halfSpan, def.arch, def.archColor), frame.x, frame.z, dirX, dirZ));
    if (def.line) objects.push(anchor(makeLine(roadHalf), frame.x, frame.z, dirX, dirZ));
    if (def.lights) {
      const lights = makeLights();
      const q = side(frame.x, frame.z, halfSpan + 1);
      objects.push(anchor(lights.group, q.x, q.z, dirX, dirZ));
      lamps = lights.lamps;
    }
    if (def.props) {
      // Builders put +x away from the road: turned round on the left side.
      const s = def.propsLeft ? -1 : 1;
      const q = side(frame.x, frame.z, s * (halfSpan + PROPS_GAP_M));
      objects.push(anchor(bakeProps(def.props()), q.x, q.z, s * dirX, s * dirZ));
    }
    if (def.flags) {
      for (const s of [-1, 1]) {
        const q = side(frame.x, frame.z, s * halfSpan);
        const object = anchor(makeFlag(def.flags), q.x, q.z, dirX, dirZ);
        object.group.userData.setLit(isLit(entry.index));
        objects.push(object);
        flags.push(object);
        lit.push(object);
        poleTops.push({ object, height: def.flags.pole ?? FLAG_POLE_M });
      }
    }
    return { dirX, dirZ, halfWidth: (point.width ?? roadWidth) / 2, objects, lamps, flags, lit, poleTops };
  }

  function removeObjects(entry) {
    for (const { group } of entry?.resolved?.objects ?? []) {
      scene.remove(group);
      disposeGroup(group);
    }
  }

  function clearPoints() {
    entries.forEach(removeObjects);
    entries = [];
  }

  function updateEntry(entry, focus) {
    const at = viewFrame.fromLatLon(entry.point.lat, entry.point.lon);
    if (focus && Math.hypot(at.x - focus.x, at.z - focus.z) > VIEW_RANGE_M) {
      for (const object of entry.resolved?.objects ?? []) object.group.visible = false;
      return;
    }
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
    // Only the next point's dots pulse and spin; the one after holds still.
    const moving = entry.index === lit;
    const pulse = moving ? 1 + 0.35 * Math.sin(time * DOT_PULSE_HZ * Math.PI * 2) : 1;
    for (const flag of entry.resolved?.flags ?? []) if (flag.group.visible) waveFlag(flag.group.userData.cloth, time);
    for (const object of entry.resolved?.lit ?? []) {
      const { dots } = object.group.userData;
      if (!dots.visible) continue;
      const { x, z } = object.group.position;
      const dist = focus ? Math.hypot(x - focus.x, z - focus.z) : 0;
      const scale = pulse * Math.min(DOT_MAX_SCALE, Math.max(1, dist / DOT_GROW_FROM_M));
      dots.scale.setScalar(scale);
      // Ring bottom stays on the pole top as it grows.
      dots.position.y = dots.userData.height + DOT_RADIUS_M * scale;
      dots.rotation.y = moving ? time * DOT_SPIN : 0;
    }
  }

  return {
    /** Shows scenery for these points (the whole itinerary, driving order), replacing any previous set. */
    setPoints(points) {
      clearPoints();
      active = 0;
      lit = -1;
      entries = points.map((point, index) => ({ point, points, index, resolved: null, retryAt: 0 }));
    },
    /** Point `offset` becomes index 0 of getGate / setLights / celebrate / sparkle; start lights go dark. */
    setActive(offset) {
      active = offset;
      for (const entry of entries) entry.resolved?.lamps?.forEach((lamp) => lamp.material.color.setHex(LAMP_OFF));
    },
    /** The rally base's tent, or none for null. */
    setBase(point) {
      removeObjects(baseEntry);
      baseEntry = point ? { point: { ...point, type: 'base' }, points: [point], index: 0, resolved: null, retryAt: 0 } : null;
    },
    clear() {
      clearPoints();
      this.setBase(null);
    },

    /**
     * Point i's gate across the road in world metres: centre, travel direction, half width;
     * dir is null until the road there is known (then only distance can be checked).
     */
    getGate(i) {
      const entry = entries[active + i];
      if (!entry) return null;
      const { x, z } = viewFrame.fromLatLon(entry.point.lat, entry.point.lon);
      const r = entry.resolved;
      return { x, z, dirX: r?.dirX ?? null, dirZ: r?.dirZ ?? null, halfWidth: r?.halfWidth ?? (entry.point.width ?? 10) / 2 };
    },

    /** Point i (the next one to pass) and the one after: flags in colour, glowing dots on poles; others grey; -1 = none. */
    setNext(i) {
      const next = i >= 0 ? active + i : -1;
      if (next === lit) return;
      lit = next;
      entries.forEach((entry, n) => entry.resolved?.lit.forEach((object) => object.group.userData.setLit(isLit(n))));
    },

    /** Start lights at point i: `red` lamps lit (0..5), or all green. */
    setLights(i, red, green = false) {
      const lamps = entries[active + i]?.resolved?.lamps;
      if (!lamps) return;
      lamps.forEach((lamp, n) => lamp.material.color.setHex(green ? LAMP_GREEN : n < red ? LAMP_RED : LAMP_OFF));
    },

    /** Fireworks from point i's flags (or the point itself). */
    celebrate(i) {
      const entry = entries[active + i];
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
      const poleTops = entries[active + i]?.resolved?.poleTops ?? [];
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
        const x = gate.x + ax * s * poleHalfSpan(gate.halfWidth);
        const z = gate.z + az * s * poleHalfSpan(gate.halfWidth);
        const y = terrain.surfaceHeightAt(x, z);
        if (y != null) sparkles.throw(x, y + SPARKLE_HEIGHT_M, z);
      }
    },

    /** @param {{x: number, z: number} | null} focus - the car; scenery far from it is hidden. */
    update(dt, focus = null) {
      time += dt;
      for (const entry of entries) updateEntry(entry, focus);
      if (baseEntry) updateEntry(baseEntry, focus);
      fireworks.update(dt);
      sparkles.update(dt);
    },

    shiftOrigin(dx, dz) {
      fireworks.shiftOrigin(dx, dz);
      sparkles.shiftOrigin(dx, dz);
    },
  };
}
