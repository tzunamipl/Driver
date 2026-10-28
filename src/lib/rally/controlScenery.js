// Roadside scenery for a whole itinerary's points, FIA style: yellow/red/beige boards
// on both sides of the road (100 m before, at, 25 m after the control), start/finish
// arches with lines, start lights, tall split flags (smaller ones for passage controls),
// per-type props (zoneProps.js). Also each point's gate line for timing, indexed from the
// active item. Placed once the streets around a point are loaded; anchored in lat/lon and
// repositioned every frame, so teleports and origin shifts need nothing special.
// Flags, board posts and start lights knock over like road posts (knockable.js) and stand
// again once the car is far from where they fell; no other control prop collides. Props with an
// `action` (tyre fitting, refuel, service) answer pickAction() and take a hover outline.
// Course objects (setObjects, courseProps.js) stand at their own lat/lon and heading: hay
// bales are static colliders, tape stakes and signs knock over, a tape span tears when hit.

import {
  BackSide,
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
  Vector3,
} from 'three';
import { addGlintSource, glintCone } from '../lampGlints.js';
import * as CANNON from 'cannon-es';
import { createTrigger, launchDebris, settleDebris } from '../knockable.js';
import { BUILDING_COLLISION_GROUP, BUILDING_MATERIAL } from '../buildings.js';
import { controlFrame, headingToDir } from '../scenarios/roadSnap.js';
import { boardTexture, bannerTexture } from './fiaBoards.js';
import { createFireworks } from './fireworks.js';
import { createSparkles } from '../particles/sparkles.js';
import { CLOCK_HEIGHT_M, makeClock, setClockTime } from './timingClock.js';
import * as props from './zoneProps.js';
import { bakeProps } from './zoneProps.js';
import { TAPE_HEIGHT_M, TAPE_STAKE_SPACING_M, makeHayBale, makeTapeSpan, makeTapeStake, makeWarningSign, tapeSpanShape } from './courseProps.js';

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
const DOT_RADIUS_M = 0.25;
const DOT_PULSE_HZ = 1.5;
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
const LAMP_GLINT = { intensity: 3 }; // lit start lamp's wet road glint, coloured as the lamp
const GLINT_CONE = glintCone(1.4, 0.5, 2); // glowing faces and lamps: wide, facing the approach
const GLINT_DISTANCE_M = 25;
const DOT_GLINT_INTENSITY = 3; // pole-top ball's wet road glint, coloured as the ball
const DOT_GLINT_CONE = glintCone(1.5, 0.3, 2); // aimed down: the ball glows all round
const DOWN = new Vector3(0, -1, 0);
const TRIGGER_RADIUS_M = 40; // knock triggers only near the car
const RESTAND_M = 200; // a knocked object stands again once the car is this far from it
const POST_HALF_M = 0.06;
const TABLE_CLOCK_AT = [0.9, 0.76]; // marshal tent's table (zoneProps.js): x from the props origin, top height
const TABLE_CLOCK_TURN = Math.PI / 6; // from facing the road towards approaching cars
const LIGHTS_TOP_M = 2.8;
const OUTLINE_M = 0.05; // hover outline: the props' hull pushed out along its normals
const OUTLINE_READY = 0xffd400; // usable now
const OUTLINE_FAR = 0xffffff; // the car has to come closer
// Course objects get their colliders only once the car is this far from them: the editor places them at the car.
const ARM_M = 5;
const COURSE_BUILDERS = { hayBale: makeHayBale, warningSign: makeWarningSign };
const X_AXIS = new Vector3(1, 0, 0);
const _tapeFrom = new Vector3();
const _tapeDir = new Vector3();

// boards: symbol on the yellow/red/beige boards; zoneEnd false = no beige board; boardHeight: board centre (m);
// bothWays: approachable from either side: only a two-faced red board, no warning or zone end boards;
// flags: feather flag on each side of the road (text, colour; pole height and cloth length / width in m),
// in colour only while it's the next point to pass, grey otherwise;
// props: zoneProps.js builder set beside the road (right of travel, or left with propsLeft);
// clock: time-of-day clock on the marshal tent's table ('table'), else on the start lights or the props-side red board ('pole');
// action: the props can be clicked for this service ('tyres' | 'refuel' | 'service' | 'remoteService'), or the rally info ('info').
const SCENERY = {
  timeControl: { boards: 'clock', props: props.makeMarshalTent, propsLeft: true, clock: 'table' },
  start: { arch: 'START', archColor: '#1d4fd8', lights: true, line: true, props: props.makeTimingHut, propsLeft: true, clock: 'pole' },
  split: { flags: { text: 'SPLIT', color: '#ff6a00' }, props: props.makeSplitBox },
  passageControl: { flags: { text: 'PC', color: '#7b3fe0', pole: 2.5, length: 1.5, width: 0.5 }, props: props.makePassageProps, propsLeft: true },
  finish: { boards: 'chequered', zoneEnd: false, arch: 'FINISH', archColor: '#d71e1e', line: true, props: props.makeTimekeeperTent, propsLeft: true },
  stop: { boards: 'STOP', props: props.makeMarshalTent, propsLeft: true, clock: 'table' },
  serviceParkIn: { boards: 'clock', props: props.makeServiceGate, clock: 'pole' },
  serviceParkOut: { boards: 'clock', props: props.makeServiceGate, clock: 'pole' },
  regroup: { boards: 'clock', props: props.makeRegroupProps, clock: 'pole' },
  refuel: { boards: 'FUEL', bothWays: true, props: props.makeRefuelProps, action: 'refuel' },
  tyreFitting: { boards: 'TYRES', bothWays: true, props: props.makeTyreProps, action: 'tyres' },
  service: { boards: 'SERVICE', bothWays: true, props: props.makeServiceProps, action: 'service' },
  remoteService: { boards: 'RSZ', bothWays: true, props: props.makeRemoteServiceProps, action: 'remoteService' },
  parcFerme: { boards: 'PARC FERMÉ', props: props.makeParcFermeProps },
  podium: { arch: 'PODIUM', archColor: '#c08a10', line: true, props: props.makePodiumProps },
  base: { props: props.makeBaseTent, propsLeft: true, action: 'info' },
};

const postGeometry = new CylinderGeometry(0.05, 0.05, BOARD_HEIGHT_M + BOARD_SIZE_M / 2, 6);
postGeometry.translate(0, (BOARD_HEIGHT_M + BOARD_SIZE_M / 2) / 2, 0);
const poleGeometry = new CylinderGeometry(0.06, 0.06, FLAG_POLE_M, 6);
poleGeometry.translate(0, FLAG_POLE_M / 2, 0);
const boardGeometry = new PlaneGeometry(BOARD_SIZE_M, BOARD_SIZE_M);
const dotGeometry = new SphereGeometry(DOT_RADIUS_M, 16, 12);
dotGeometry.userData.shared = true;
const lampGeometry = new SphereGeometry(0.11, 10, 8);
const greyMaterial = new MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.6 });
const whiteMaterial = new MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 });
const boardMaterials = new Map();

/** Back faces pushed out along the normals: an outline round whatever mesh it shares geometry with. */
function outlineMaterial(color) {
  const material = new MeshBasicMaterial({ color, side: BackSide });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\ntransformed += normalize(normal) * ${OUTLINE_M.toFixed(3)};`);
  };
  material.userData.shared = true;
  return material;
}
const outlineMaterials = { ready: outlineMaterial(OUTLINE_READY), far: outlineMaterial(OUTLINE_FAR) };

/**
 * The point type's control boards as [colour, metres along travel, facing]: facing 1 =
 * towards traffic in driving order, -1 = the other way. Empty for types without boards.
 */
export function boardSpots(type) {
  const def = SCENERY[type];
  if (!def?.boards) return [];
  if (def.bothWays) return [['red', 0, 1]];
  const spots = [['yellow', -WARNING_BOARD_M, 1], ['red', 0, 1]];
  if (def.zoneEnd !== false) spots.push(['beige', ZONE_END_M, 1]);
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
  const top = height + BOARD_SIZE_M / 2;
  group.userData.knock = knockSpec([0, top / 2, 0], [POST_HALF_M, top / 2, POST_HALF_M], {
    mass: 8,
    hitSound: 'metal',
    debrisRadius: 0.08,
    // Along the post, plus the board's ends, so it lies on them.
    debrisSpheres: [[0, -top * 0.35, 0], [0, 0, 0], ...[-1, 1].map((s) => [s * 0.4, top / 2 - BOARD_SIZE_M / 2, 0])],
  });
  return group;
}

/**
 * A knockable object's trigger box and debris body, from its ground origin: box `center`,
 * `half` extents; spec (knockable.js launchDebris + hitSound) has sphere offsets from the centre.
 */
function knockSpec(center, half, spec) {
  return { center, shape: new CANNON.Box(new CANNON.Vec3(...half)), ...spec };
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
    lamp.userData.glint = LAMP_GLINT;
    lamp.position.set(0, 2.5 - i * 0.26, 0.22);
    group.add(lamp);
    lamps.push(lamp);
  }
  group.userData.knock = knockSpec([0, 1.4, 0], [0.2, 1.4, 0.2], {
    mass: 30,
    hitSound: 'metal',
    debrisRadius: 0.2,
    debrisSpheres: [[0, -1.2, 0], [0, 0, 0], [0, 1.2, 0]],
  });
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

/** A glowing ball on a pole top at `height`, shown while the point is lit; reads as a circle from any side. */
function makeDots(color, height) {
  const dots = new Mesh(dotGeometry, dotMaterial(color));
  dots.userData.height = height;
  dots.userData.glint = { intensity: DOT_GLINT_INTENSITY, down: true };
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
  // Box over the pole and the cloth beside it (the cloth hangs into the road on the left).
  const cx = (0.05 + width - POST_HALF_M) / 2;
  group.userData.knock = knockSpec([cx, pole / 2, 0], [(0.05 + width + POST_HALF_M) / 2, pole / 2, POST_HALF_M], {
    mass: 1 + pole * 0.8,
    debrisRadius: 0.06,
    debrisSpheres: [[-cx, -pole / 2 + 0.3, 0], [-cx, pole / 2 - 0.3, 0], [0.05 + width - cx, pole / 2 - 0.1 - length / 2, 0]],
  });
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

/** A clock standing on top of a pole at `top`, facing local +z. */
function clockOnPole(top) {
  const clock = makeClock();
  clock.position.y = top + 0.05 + CLOCK_HEIGHT_M / 2;
  return clock;
}

/**
 * @param {{onSparkle?: () => void, onHit?: (speed: number, spec: object) => void, getTimeOfDayMs?: () => number, editor?: boolean}} deps - onSparkle:
 * sound hook, once per sparkle(); onHit: the car knocked an object over (spec.hitSound, spec.mass); getTimeOfDayMs: the
 * simulated clock (epoch ms) the control clocks show; editor: nothing collides or knocks over, and points show only
 * their zone props (the editor's markers stand in for boards, arches and flags).
 */
export function createControlScenery({ scene, world, streets, terrain, viewFrame, onSparkle, onHit = () => {}, getTimeOfDayMs = Date.now, editor = false }) {
  const fireworks = createFireworks(scene);
  const sparkles = createSparkles(scene);
  /** @type {{point: object, travel: {x: number, z: number} | null, resolved: object | null, retryAt: number}[]} */
  let entries = [];
  let active = 0; // entries index of the active item's first point
  let lit = -1; // entries index of the first of LIT_AHEAD points whose flags are in colour
  let baseEntry = null; // rally base: shown for the whole rally, not one of the indexed points
  let courseEntries = []; // one per course object (setObjects)
  let time = 0;
  const pendingHits = []; // { object | span, by }, queued during the physics step
  let outlined = null; // { object, mesh }: hovered action props

  const isLit = (index) => lit >= 0 && index >= lit && index < lit + LIT_AHEAD;
  const neighbour = (points, i) => (points[i] ? viewFrame.fromLatLon(points[i].lat, points[i].lon) : null);

  /** Where an anchored object (or its debris) is now. */
  const positionOf = (object) => (object.debris ? object.debris.mesh.position : object.group.position);

  function dropTrigger(object) {
    if (!object.trigger) return;
    world.removeBody(object.trigger);
    object.trigger = null;
  }

  function dropSolid(object) {
    if (!object.solid) return;
    world.removeBody(object.solid);
    object.solid = null;
  }

  /** Puts `body` at the object's group pose, `center` (object frame) as its origin. */
  function poseBody(body, object, [cx, cy, cz]) {
    const { x, y, z } = object.group.position;
    const cos = Math.cos(object.yaw);
    const sin = Math.sin(object.yaw);
    body.position.set(x + cx * cos + cz * sin, y + cy, z - cx * sin + cz * cos);
    body.quaternion.setFromAxisAngle(CANNON.Vec3.UNIT_Y, object.yaw);
    body.aabbNeedsUpdate = true;
  }

  /** Trigger on a standing knockable object at its group's current pose. */
  function placeTrigger(object) {
    const { knock } = object.group.userData;
    if (!object.trigger) {
      object.trigger = createTrigger(knock.shape, (by) => pendingHits.push({ object, by }));
      world.addBody(object.trigger);
    }
    poseBody(object.trigger, object, knock.center);
  }

  /** Static collider (like a building: impacts, damage) on a solid course object. */
  function placeSolid(object) {
    const { solid } = object.group.userData;
    if (!object.solid) {
      object.solid = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, material: BUILDING_MATERIAL, collisionFilterGroup: BUILDING_COLLISION_GROUP });
      object.solid.addShape(solid.shape, undefined, solid.orientation);
      world.addBody(object.solid);
    }
    poseBody(object.solid, object, solid.center);
  }

  function dropSpanTrigger(span) {
    if (!span.trigger) return;
    world.removeBody(span.trigger);
    span.trigger = null;
  }

  /** Swaps a standing object for a tumbling one, its group inside a wrapper centred on the body. */
  function knockOver(object, by) {
    const { trigger, group } = object;
    const { knock } = group.userData;
    dropTrigger(object);
    const body = launchDebris(world, knock, trigger.position, trigger.quaternion, by);
    const wrapper = new Group();
    wrapper.position.copy(body.position);
    wrapper.quaternion.copy(body.quaternion);
    group.position.set(-knock.center[0], -knock.center[1], -knock.center[2]);
    group.rotation.set(0, 0, 0);
    wrapper.add(group); // out of the scene, into the wrapper
    scene.add(wrapper);
    object.debris = { mesh: wrapper, body, age: 0, restAge: 0 };
    onHit(by.velocity.length(), knock);
  }

  /** Back to standing: anchoring places it again. */
  function restand(object) {
    const { debris, group } = object;
    if (debris.body) world.removeBody(debris.body);
    scene.add(group);
    scene.remove(debris.mesh);
    object.debris = null;
  }

  function flushHits() {
    for (const { object, span, by } of pendingHits.splice(0)) {
      if (span) {
        if (span.trigger) {
          span.torn = true;
          dropSpanTrigger(span);
        }
      } else if (object.trigger && !object.debris) knockOver(object, by);
    }
  }

  // Glowing parts (userData.glint: { intensity, color? = the material's }) of standing, shown objects.
  addGlintSource((add, x, z, rangeSq) => {
    for (const entry of baseEntry ? [...entries, baseEntry] : entries) {
      for (const object of entry.resolved?.objects ?? []) {
        if (!object.group.visible) continue;
        const p = positionOf(object);
        if ((p.x - x) ** 2 + (p.z - z) ** 2 > rangeSq) continue;
        object.group.traverseVisible((obj) => {
          const glint = obj.userData.glint;
          if (!glint || (!glint.color && obj.material.color.getHex() === LAMP_OFF)) return;
          const aim = glint.down ? DOWN : obj.getWorldDirection(new Vector3());
          add(obj.getWorldPosition(new Vector3()), aim, glint.down ? DOT_GLINT_CONE : GLINT_CONE, GLINT_DISTANCE_M, glint.intensity, glint.color ?? obj.material.color);
        });
      }
    }
  });

  function anchor(group, x, z, dirX, dirZ) {
    group.traverse((obj) => (obj.castShadow = true));
    scene.add(group);
    group.visible = false;
    return { group, ...viewFrame.toLatLon(x, z), yaw: yawFacing(dirX, dirZ) };
  }

  /** A course object at its lat/lon facing its heading; a tape's stakes run across the heading, centred there. */
  function resolveCourse({ point }) {
    const at = viewFrame.fromLatLon(point.lat, point.lon);
    const { dirX, dirZ } = headingToDir(point.heading ?? 0);
    const objects = [];
    const spans = [];
    const place = (group, x, z) => {
      const object = { ...anchor(group, x, z, dirX, dirZ), armed: false };
      objects.push(object);
      return object;
    };
    if (point.type === 'tape') {
      const { length } = point;
      const gaps = Math.max(1, Math.round(length / TAPE_STAKE_SPACING_M));
      let prev = null;
      for (let i = 0; i <= gaps; i++) {
        const along = -length / 2 + (i * length) / gaps;
        // Right of the heading: (-dirZ, dirX).
        const stake = place(makeTapeStake(), at.x - dirZ * along, at.z + dirX * along);
        if (prev) {
          const mesh = makeTapeSpan(length / gaps);
          mesh.visible = false;
          scene.add(mesh);
          spans.push({ mesh, a: prev, b: stake, length: length / gaps, trigger: null, torn: false });
        }
        prev = stake;
      }
    } else if (COURSE_BUILDERS[point.type]) place(COURSE_BUILDERS[point.type](), at.x, at.z);
    return { dirX, dirZ, halfWidth: 0, objects, lamps: null, flags: [], lit: [], poleTops: [], spans };
  }

  /** Tape span between its stakes: shown while both stand and it isn't torn; torn ones mend once the car is far. */
  function updateSpan(span, focus) {
    const { mesh, a, b } = span;
    const pa = a.group.position;
    const pb = b.group.position;
    const mx = (pa.x + pb.x) / 2;
    const mz = (pa.z + pb.z) / 2;
    const dist = focus ? Math.hypot(mx - focus.x, mz - focus.z) : Infinity;
    if (span.torn && dist > RESTAND_M) span.torn = false;
    mesh.visible = !span.torn && !a.debris && !b.debris && a.group.visible && b.group.visible;
    if (!mesh.visible) return dropSpanTrigger(span);
    _tapeFrom.set(pa.x, pa.y + TAPE_HEIGHT_M, pa.z);
    _tapeDir.set(pb.x, pb.y + TAPE_HEIGHT_M, pb.z).sub(_tapeFrom);
    mesh.position.copy(_tapeFrom);
    mesh.scale.x = _tapeDir.length() / span.length;
    mesh.quaternion.setFromUnitVectors(X_AXIS, _tapeDir.normalize());
    if (editor || dist > TRIGGER_RADIUS_M || !a.armed || !b.armed) return dropSpanTrigger(span);
    if (!span.trigger) {
      span.trigger = createTrigger(tapeSpanShape(span.length), (by) => pendingHits.push({ span, by }));
      world.addBody(span.trigger);
    }
    span.trigger.position.set(mx, (pa.y + pb.y) / 2 + TAPE_HEIGHT_M, mz);
    span.trigger.quaternion.setFromAxisAngle(CANNON.Vec3.UNIT_Y, a.yaw);
  }

  /** Builds the point's scenery around its road (or heading); null while the streets there aren't loaded. */
  function resolve(entry) {
    const { point } = entry;
    if (entry.course) return resolveCourse(entry);
    const at = viewFrame.fromLatLon(point.lat, point.lon);
    // Facing follows the driving order: from the previous point towards the next one.
    const frame = controlFrame(streets, at.x, at.z, point, neighbour(entry.points, entry.index - 1), neighbour(entry.points, entry.index + 1), SNAP_RADIUS_M);
    if (!frame) return null;
    const { dirX, dirZ } = frame;
    const roadWidth = frame.roadWidth ?? point.width ?? 0;
    const roadHalf = Math.max(point.width ?? 0, roadWidth) / 2;
    const halfSpan = poleHalfSpan(roadHalf);
    const full = SCENERY[point.type] ?? {};
    const def = editor ? { props: full.props, propsLeft: full.propsLeft, clock: full.clock === 'table' ? 'table' : undefined } : full;
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
          const board = makeBoard(color, def.boards, def.boardHeight, def.bothWays && along === 0);
          const height = (def.boardHeight ?? BOARD_HEIGHT_M) + BOARD_SIZE_M / 2;
          if (along === 0 && def.clock === 'pole' && !def.lights && s === (def.propsLeft ? -1 : 1)) board.add(clockOnPole(height));
          const object = anchor(board, q.x, q.z, pDirX, pDirZ);
          objects.push(object);
          if (along === 0) {
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
      if (def.clock === 'pole') lights.group.add(clockOnPole(LIGHTS_TOP_M));
      const q = side(frame.x, frame.z, halfSpan + 1);
      objects.push(anchor(lights.group, q.x, q.z, dirX, dirZ));
      lamps = lights.lamps;
    }
    if (def.props) {
      // Builders put +x away from the road: turned round on the left side.
      const s = def.propsLeft ? -1 : 1;
      const q = side(frame.x, frame.z, s * (halfSpan + PROPS_GAP_M));
      const built = def.props();
      const propsObject = anchor(bakeProps(built), q.x, q.z, s * dirX, s * dirZ);
      const cos = Math.cos(propsObject.yaw);
      const sin = Math.sin(propsObject.yaw);
      for (const part of built.userData.loose ?? []) {
        const { x: lx, z: lz } = part.position;
        part.position.x = part.position.z = 0;
        objects.push(anchor(bakeProps(part), q.x + lx * cos + lz * sin, q.z - lx * sin + lz * cos, s * dirX, s * dirZ));
      }
      if (def.action) {
        propsObject.action = def.action;
        propsObject.pointIndex = entry.index;
      }
      objects.push(propsObject);
      if (def.clock === 'table') {
        // Same frame as the props; approaching cars are at local +z on the right side, -z on the left.
        const holder = new Group();
        const clock = makeClock();
        clock.position.set(TABLE_CLOCK_AT[0], TABLE_CLOCK_AT[1] + CLOCK_HEIGHT_M / 2, 0);
        clock.rotation.y = -Math.PI / 2 + s * TABLE_CLOCK_TURN;
        holder.add(clock);
        objects.push(anchor(holder, q.x, q.z, s * dirX, s * dirZ));
      }
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
    for (const object of entry?.resolved?.objects ?? []) {
      if (outlined?.object === object) outlined = null;
      dropTrigger(object);
      dropSolid(object);
      if (object.debris) restand(object);
      scene.remove(object.group);
      disposeGroup(object.group);
    }
    for (const span of entry?.resolved?.spans ?? []) {
      dropSpanTrigger(span);
      scene.remove(span.mesh);
      span.mesh.geometry.dispose();
    }
  }

  function clearPoints() {
    entries.forEach(removeObjects);
    entries = [];
  }

  function updateEntry(entry, focus, dt) {
    for (const object of entry.resolved?.objects ?? []) {
      if (!object.debris) continue;
      const p = object.debris.mesh.position;
      if (!focus || Math.hypot(p.x - focus.x, p.z - focus.z) > RESTAND_M) restand(object);
      else settleDebris(world, object.debris, dt);
    }
    const at = viewFrame.fromLatLon(entry.point.lat, entry.point.lon);
    if (entry.hidden || (focus && Math.hypot(at.x - focus.x, at.z - focus.z) > VIEW_RANGE_M)) {
      for (const object of entry.resolved?.objects ?? []) {
        object.group.visible = false;
        dropTrigger(object);
        dropSolid(object);
      }
      for (const span of entry.resolved?.spans ?? []) {
        span.mesh.visible = false;
        dropSpanTrigger(span);
      }
      return;
    }
    if (!entry.resolved && time >= entry.retryAt) {
      entry.resolved = resolve(entry);
      entry.retryAt = time + RESOLVE_RETRY_S;
    }
    for (const object of entry.resolved?.objects ?? []) {
      if (object.debris) continue;
      const { x, z } = viewFrame.fromLatLon(object.lat, object.lon);
      const y = terrain.surfaceHeightAt(x, z);
      object.group.visible = y != null;
      if (y == null) {
        dropTrigger(object);
        dropSolid(object);
        continue;
      }
      object.group.position.set(x, y, z);
      object.group.rotation.y = object.yaw;
      const dist = focus ? Math.hypot(x - focus.x, z - focus.z) : Infinity;
      if (object.armed === false && focus && dist > ARM_M) object.armed = true;
      const near = !editor && dist < TRIGGER_RADIUS_M && object.armed !== false;
      const { knock, solid } = object.group.userData;
      if (near && knock) placeTrigger(object);
      else dropTrigger(object);
      if (near && solid) placeSolid(object);
      else dropSolid(object);
    }
    for (const span of entry.resolved?.spans ?? []) updateSpan(span, focus);
    // Only the next point's dot pulses; the one after holds still.
    const moving = entry.index === lit;
    const pulse = moving ? 1 + 0.35 * Math.sin(time * DOT_PULSE_HZ * Math.PI * 2) : 1;
    for (const flag of entry.resolved?.flags ?? []) if (flag.group.visible) waveFlag(flag.group.userData.cloth, time);
    for (const object of entry.resolved?.lit ?? []) {
      const { dots } = object.group.userData;
      if (!dots.visible) continue;
      const { x, z } = positionOf(object);
      const dist = focus ? Math.hypot(x - focus.x, z - focus.z) : 0;
      const scale = pulse * Math.min(DOT_MAX_SCALE, Math.max(1, dist / DOT_GROW_FROM_M));
      dots.scale.setScalar(scale);
      dots.userData.glint.intensity = DOT_GLINT_INTENSITY * pulse;
      // Ball bottom stays on the pole top as it grows.
      dots.position.y = dots.userData.height + DOT_RADIUS_M * scale;
    }
  }

  /** Visible props with an action, for pickAction. */
  function actionObjects() {
    const list = [];
    for (const entry of baseEntry ? [...entries, baseEntry] : entries) {
      for (const object of entry.resolved?.objects ?? []) if (object.action && object.group.visible) list.push(object);
    }
    return list;
  }

  return {
    /**
     * The nearest clickable props under the ray: { action, x, z (props position), index (its point in setPoints order, none for the base) }, or null.
     * @param {import('three').Raycaster} raycaster
     */
    pickAction(raycaster) {
      const objects = actionObjects();
      const hit = raycaster.intersectObjects(objects.map((o) => o.group), false)[0];
      const object = hit && objects.find((o) => o.group === hit.object);
      return object ? { action: object.action, x: object.group.position.x, z: object.group.position.z, index: object.pointIndex, object } : null;
    },

    /** Outlines a pickAction() result's props: state 'ready' | 'far', or none for null. */
    setOutline(picked, state) {
      const object = picked?.object ?? null;
      if (outlined && (outlined.object !== object || !state)) {
        outlined.object.group.remove(outlined.mesh);
        outlined = null;
      }
      if (!object || !state) return;
      if (!outlined) {
        outlined = { object, mesh: new Mesh(object.group.geometry, outlineMaterials[state]) };
        outlined.mesh.raycast = () => {}; // never picked itself
        object.group.add(outlined.mesh);
      }
      outlined.mesh.material = outlineMaterials[state];
    },

    /** Shows scenery for these points (the whole itinerary, driving order), replacing any previous set. */
    setPoints(points) {
      clearPoints();
      active = 0;
      lit = -1;
      entries = points.map((point, index) => ({ point, points, index, resolved: null, retryAt: 0 }));
    },
    /** Points (setPoints indices) whose scenery stays down, e.g. other runs of a stage driven more than once. */
    setHidden(indices) {
      const hidden = new Set(indices);
      entries.forEach((entry, n) => (entry.hidden = hidden.has(n)));
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
    /**
     * Course objects ({ type: 'hayBale' | 'tape' | 'warningSign', lat, lon, heading, length? }), replacing the previous
     * set; with keepState, unchanged ones stay as they are (knocked over, torn).
     */
    setObjects(objects, { keepState = false } = {}) {
      const signature = (o) => `${o.type}|${o.lat}|${o.lon}|${o.heading}|${o.length}`;
      const previous = courseEntries;
      const old = new Map();
      for (const entry of keepState ? courseEntries : []) {
        const key = signature(entry.point);
        old.set(key, [...(old.get(key) ?? []), entry]);
      }
      courseEntries = objects.map((point) => old.get(signature(point))?.shift() ?? { point: { ...point }, course: true, points: null, index: -1, resolved: null, retryAt: 0 });
      for (const entry of previous) if (!courseEntries.includes(entry)) removeObjects(entry);
    },
    clear() {
      clearPoints();
      this.setBase(null);
      this.setObjects([]);
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
      const spots = entry.resolved?.flags.length ? entry.resolved.flags.map(positionOf) : [];
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
          const { x, y, z } = positionOf(object);
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
      setClockTime(getTimeOfDayMs());
      flushHits();
      for (const entry of entries) updateEntry(entry, focus, dt);
      if (baseEntry) updateEntry(baseEntry, focus, dt);
      for (const entry of courseEntries) updateEntry(entry, focus, dt);
      fireworks.update(dt);
      sparkles.update(dt);
    },

    shiftOrigin(dx, dz) {
      fireworks.shiftOrigin(dx, dz);
      sparkles.shiftOrigin(dx, dz);
    },
  };
}
