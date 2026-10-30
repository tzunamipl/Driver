import * as THREE from 'three';
import { NEUTRAL } from '../lib/engine.js';
import { createGearGate } from '../lib/gearGate.js';

// Manual-gearbox stick: a small 3D H-gate in its own canvas next to the
// gauges, dragged with the mouse/finger. The lever stays upright and slides
// (no pivot), so the knob tracks the pointer 1:1. It only moves along the gate
// (sideways on the neutral rail, fore/aft in a column); reaching a slot end
// asks the engine for that gear, leaving it goes to neutral. Range-change
// boxes get a second, fore/aft range lever beside it (engine.setRange: the
// main gear stays in, the range stage shifts). Shown while the manual box is
// active; G hides/shows it, X / Z move the range lever up / down. On an automatic
// (not automatic-only) box a Q/E shift pops it up for a moment, read-only.

// How long a Q/E shift on the automatic shows the stick (s).
const AUTO_SHIFT_SHOW_S = 1.5;
// Plate-plane spacing of the gate (scene units) and lever geometry.
const COLUMN_SPACING = 0.5;
const ROW_SPACING = 0.55;
const PLATE_Y = 0.75;
const LEVER_LENGTH = 1.0;
const PLATE_MARGIN = 0.45;
const PLATE_DEPTH = 2 * ROW_SPACING + 1.1;
// Range plate: width, gap to the H plate, slot offset from its centre (labels on the other side).
const RANGE_PLATE_WIDTH = 1.0;
const RANGE_PLATE_GAP = 0.12;
const RANGE_SLOT_OFFSET = -0.25;
const RANGE_COLORS = [0xdddddd, 0x4fc3ff, 0xff8c1a, 0xff4d6d];
// |y| below which the lever counts as on the neutral rail.
const RAIL_EPS = 0.02;
// The pointer drives a free "hand"; the knob slides along its groove after it
// and only changes groove near neutral, through a forgiving junction zone:
// leaving a column needs |y| below JUNCTION_Y and the hand pulled sideways by
// SIDE_PULL columns; entering one needs the knob within COLUMN_CAPTURE of it
// and the hand ENTER_Y past the rail.
const JUNCTION_Y = 0.4;
const SIDE_PULL = 0.45;
const COLUMN_CAPTURE = 0.4;
const ENTER_Y = 0.15;
// How far past the gate's ends the hand may wander (gate units), so reversing feels immediate.
const HAND_OVERSHOOT = 0.3;
// Slot engagement hysteresis (|y|) and where a refused (wrong-way) gear knocks the lever back to.
const ENGAGE_Y = 0.75;
const RELEASE_Y = 0.5;
const REFUSED_Y = 0.45;
// Lever travel when it follows the engine (keys, release spring), gate units/s.
const FOLLOW_SPEED = 7;
// Drawn knob chases the lever position along the gate this fast (gate units/s), so groove jumps glide instead of snapping.
const KNOB_SPEED = 30;
const TEXTURE_PX_PER_UNIT = 160;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function approach(v, target, step) {
  return v < target ? Math.min(target, v + step) : Math.max(target, v - step);
}

/** Moves `p` up to `step` towards `target` through the gate: out to the rail, along it, into the column. */
function slideAlongGate(p, target, step) {
  while (step > 1e-6) {
    let d;
    if (Math.abs(p.x - target.x) > 1e-3) {
      if (p.y !== 0) {
        d = Math.min(step, Math.abs(p.y));
        p.y = approach(p.y, 0, d);
      } else {
        d = Math.min(step, Math.abs(p.x - target.x));
        p.x = approach(p.x, target.x, d);
      }
    } else {
      p.x = target.x;
      d = Math.min(step, Math.abs(p.y - target.y));
      if (d === 0) return;
      p.y = approach(p.y, target.y, d);
    }
    step -= d;
  }
}

function cssColor(hex) {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/** Textured plate + upright sliding lever. */
function createLeverUnit(scene, { knobRadius }) {
  const canvas = document.createElement('canvas');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const side = new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.6, metalness: 0.3 });
  const top = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.55, metalness: 0.2 });
  const plate = new THREE.Mesh(new THREE.BoxGeometry(1, 0.06, 1), [side, side, top, side, side, side]);
  plate.position.y = PLATE_Y - 0.03;

  const boot = new THREE.Mesh(
    new THREE.ConeGeometry(knobRadius * 1.25, 0.3, 20, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9, side: THREE.DoubleSide })
  );
  boot.geometry.translate(0, 0.15, 0);
  boot.position.y = PLATE_Y - 0.02;

  const lever = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.05, LEVER_LENGTH, 12),
    new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.3, metalness: 0.9 })
  );
  shaft.position.y = LEVER_LENGTH / 2;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(knobRadius, 24, 16), new THREE.MeshStandardMaterial({ color: 0x222226, roughness: 0.35 }));
  knob.position.y = LEVER_LENGTH;
  knob.scale.set(1, 0.85, 1);
  const capMaterial = new THREE.MeshStandardMaterial({ color: RANGE_COLORS[0], roughness: 0.4 });
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(knobRadius * 0.56, knobRadius * 0.56, 0.02, 20), capMaterial);
  cap.position.y = LEVER_LENGTH + knobRadius * 0.84;
  lever.add(shaft, knob, cap);
  scene.add(plate, boot, lever);

  return {
    canvas,
    capMaterial,
    setVisible(visible) {
      plate.visible = boot.visible = lever.visible = visible;
    },
    /** Plate centre x and size (scene units); resizes the texture canvas. */
    layout(cx, width, depth) {
      plate.position.x = cx;
      plate.scale.set(width, 1, depth);
      canvas.width = Math.round(width * TEXTURE_PX_PER_UNIT);
      canvas.height = Math.round(depth * TEXTURE_PX_PER_UNIT);
    },
    place(x, z) {
      lever.position.set(x, 0, z);
      boot.position.x = x;
      boot.position.z = z;
    },
    redrawn() {
      texture.needsUpdate = true;
    },
  };
}

export function createGearstickHud() {
  const root = document.getElementById('gearstick');
  const canvas = document.getElementById('gearstick-canvas');
  if (!root || !canvas) return { update() {} };

  let renderer = null; // created on first show (no second WebGL context until needed)
  let sizeKey = '';
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 40);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x303038, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(1.5, 4, 2.5);
  scene.add(sun);
  const gearUnit = createLeverUnit(scene, { knobRadius: 0.16 });
  const rangeUnit = createLeverUnit(scene, { knobRadius: 0.12 });

  let gate = null;
  let gateEngine = null; // engine the gate was built for (new per spawn/vehicle)
  let gearCx = 0; // H plate centre x
  let gearWidth = 0;
  let rangeCx = 0; // range plate centre x
  let rangeStep = 0; // range lever travel per position (scene units)
  let range = 0; // engine.range, read each frame
  let rangePos = 0; // range lever position, in range indices
  const pos = { x: 0, y: 0 }; // gear lever position in gate coordinates
  const knob = { x: 0, y: 0 }; // drawn lever position, trailing pos
  const hand = { x: 0, y: 0 }; // where the pointer is pulling the knob (gate coordinates)
  let dragging = null; // 'gear' | 'range' | null
  let lastPointer = null;
  let shown = false;
  let drawnKey = '';
  // On-screen travel (fraction of the canvas width / height) per gate column, row and range step.
  let columnFraction = 0.3;
  let rowFraction = 0.3;
  let rangeFraction = 0.3;
  let splitNdcX = Infinity; // pointer NDC x right of this grabs the range lever
  let rangeUpWasPressed = false;
  let rangeDownWasPressed = false;
  let pressEngine = null; // engine the press count / last gear below belong to
  let pressesSeen = 0;
  let lastGear = null; // engine gear at the previous frame, for the pop-up's starting lever spot
  let popupS = 0;

  function ranged() {
    return gate.ranges > 1;
  }

  function plateX(x) {
    return gearCx + (x - (gate.columns - 1) / 2) * COLUMN_SPACING;
  }

  function rangeZ(r) {
    return -(r - (gate.ranges - 1) / 2) * rangeStep;
  }

  function buildGate(engine) {
    gate = createGearGate(engine.gearCount, engine.gearRanges);
    gateEngine = engine;
    root.classList.toggle('ranged', ranged());
    gearWidth = gate.columns * COLUMN_SPACING + PLATE_MARGIN;
    const total = gearWidth + (ranged() ? RANGE_PLATE_GAP + RANGE_PLATE_WIDTH : 0);
    gearCx = -total / 2 + gearWidth / 2;
    rangeCx = total / 2 - RANGE_PLATE_WIDTH / 2;
    rangeStep = ranged() ? (2 * ROW_SPACING) / (gate.ranges - 1) : 0;
    gearUnit.layout(gearCx, gearWidth, PLATE_DEPTH);
    rangeUnit.layout(rangeCx, RANGE_PLATE_WIDTH, PLATE_DEPTH);
    rangeUnit.setVisible(ranged());
    const target = engine.manual ? gate.posForGear(engine.gear) : null;
    range = rangePos = engine.range;
    Object.assign(pos, target ? { x: target.x, y: target.y } : { x: gate.restX, y: 0 });
    Object.assign(knob, pos);
    drawnKey = '';
    sizeKey = '';
  }

  /** Frames both plates from almost straight above; refreshes the drag scales. */
  function frameCamera(width, height) {
    const aspect = width / height;
    camera.aspect = aspect;
    const total = gearWidth + (ranged() ? RANGE_PLATE_GAP + RANGE_PLATE_WIDTH : 0);
    const span = Math.max(PLATE_DEPTH, total / aspect, 1.9);
    camera.position.set(0, PLATE_Y + 2.2 * span, 0.35 * span);
    camera.lookAt(0, PLATE_Y, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const knobAt = (x, z) => new THREE.Vector3(x, LEVER_LENGTH, z).project(camera);
    const centre = knobAt(gearCx, 0);
    columnFraction = Math.abs(knobAt(gearCx + COLUMN_SPACING, 0).x - centre.x) / 2;
    rowFraction = Math.abs(knobAt(gearCx, -ROW_SPACING).y - centre.y) / 2;
    rangeFraction = ranged() ? Math.abs(knobAt(rangeCx, -rangeStep).y - knobAt(rangeCx, 0).y) / 2 : 0.3;
    splitNdcX = ranged() ? new THREE.Vector3(gearCx + gearWidth / 2 + RANGE_PLATE_GAP / 2, PLATE_Y, 0).project(camera).x : Infinity;
  }

  function drawGearPlate(engine) {
    const { canvas: tex } = gearUnit;
    const ctx = tex.getContext('2d');
    const w = tex.width;
    const h = tex.height;
    const px = (x) => w / 2 + (plateX(x) - gearCx) * TEXTURE_PX_PER_UNIT;
    const pz = (y) => h / 2 - y * ROW_SPACING * TEXTURE_PX_PER_UNIT;
    ctx.fillStyle = '#26262b';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#050506';
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.13 * TEXTURE_PX_PER_UNIT;
    ctx.beginPath();
    ctx.moveTo(px(0), pz(0));
    ctx.lineTo(px(gate.columns - 1), pz(0));
    for (let x = 0; x < gate.columns; x++) {
      for (const y of [1, -1]) {
        if (!gate.hasSlot(x, y)) continue;
        ctx.moveTo(px(x), pz(0));
        ctx.lineTo(px(x), pz(y));
      }
    }
    ctx.stroke();
    ctx.font = `bold ${Math.round(0.22 * TEXTURE_PX_PER_UNIT)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let x = 0; x < gate.columns; x++) {
      for (const y of [1, -1]) {
        const gear = gate.gearAt(x, y, range);
        if (gear === null) continue;
        ctx.fillStyle = gear === engine.gear ? '#ffb84d' : '#d8d8de';
        ctx.fillText(gear === 0 ? 'R' : String(gear), px(x), pz(y * 1.62));
      }
    }
    gearUnit.redrawn();
  }

  function drawRangePlate() {
    const { canvas: tex } = rangeUnit;
    const ctx = tex.getContext('2d');
    const w = tex.width;
    const h = tex.height;
    const sx = w / 2 + RANGE_SLOT_OFFSET * TEXTURE_PX_PER_UNIT;
    const pz = (r) => h / 2 + rangeZ(r) * TEXTURE_PX_PER_UNIT;
    ctx.fillStyle = '#26262b';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#050506';
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.11 * TEXTURE_PX_PER_UNIT;
    ctx.beginPath();
    ctx.moveTo(sx, pz(0));
    ctx.lineTo(sx, pz(gate.ranges - 1));
    ctx.stroke();
    ctx.font = `bold ${Math.round(0.15 * TEXTURE_PX_PER_UNIT)}px monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let r = 0; r < gate.ranges; r++) {
      ctx.fillStyle = r === range ? cssColor(RANGE_COLORS[r % RANGE_COLORS.length]) : '#8a8a92';
      ctx.fillText(gate.rangeLabels[r], sx + 0.2 * TEXTURE_PX_PER_UNIT, pz(r));
    }
    rangeUnit.redrawn();
  }

  function drawPlates(engine) {
    const key = `${range}|${engine.gear}`;
    if (key === drawnKey) return;
    drawnKey = key;
    drawGearPlate(engine);
    if (ranged()) drawRangePlate();
  }

  function setRange(r, engine) {
    if (r !== range && engine.setRange(r)) range = engine.range;
  }

  /** Slides the knob along the gate after the hand, through neutral only (a few groove changes per move). */
  function followHand() {
    for (let i = 0; i < 3; i++) {
      if (Math.abs(pos.y) > RAIL_EPS) {
        const column = Math.round(pos.x);
        pos.x = column;
        pos.y = clamp(hand.y, gate.hasSlot(column, -1) ? -1 : 0, gate.hasSlot(column, 1) ? 1 : 0);
        if (Math.abs(pos.y) >= JUNCTION_Y || Math.abs(hand.x - column) < SIDE_PULL) return;
        pos.y = 0;
      }
      pos.x = clamp(hand.x, 0, gate.columns - 1);
      const column = Math.round(pos.x);
      const dir = Math.sign(hand.y);
      if (Math.abs(pos.x - column) >= COLUMN_CAPTURE || Math.abs(hand.y) < ENTER_Y || !gate.hasSlot(column, dir)) return;
      pos.x = column;
      pos.y = dir * Math.min(1, Math.abs(hand.y));
    }
  }

  /** Engine gear for the lever position (with hysteresis around the current one); true if refused. */
  function selectFromLever(engine) {
    const column = Math.round(pos.x);
    // Engaged gear, or the one waiting in its slot for the synchro.
    const held = engine.keyTarget ?? (engine.gear !== NEUTRAL ? engine.gear : null);
    const current = held !== null ? gate.posForGear(held) : null;
    const inCurrent = current && current.x === column && Math.sign(pos.y) === current.y && Math.abs(pos.y) > RELEASE_Y;
    if (inCurrent) return false;
    let wanted = NEUTRAL;
    if (Math.abs(pos.y) >= ENGAGE_Y) wanted = gate.gearAt(column, Math.sign(pos.y), range) ?? NEUTRAL;
    if (wanted === (engine.keyTarget ?? engine.gear)) return false;
    if (engine.selectGear(wanted)) return false;
    pos.y = Math.sign(pos.y) * REFUSED_Y;
    return true;
  }

  /** Levers not being dragged follow the engine (Q/E shifts, spring back to the rest plane / detent). */
  function followEngine(engine, dt) {
    const gearPos = engine.gear !== NEUTRAL ? gate.posForGear(engine.gear) : null;
    const pending = engine.keyTarget !== null ? gate.posForGear(engine.keyTarget) : null;
    const step = FOLLOW_SPEED * dt;
    if (dragging !== 'range') rangePos = approach(rangePos, range, step);
    if (dragging === 'gear') return;
    const target = gearPos ?? pending ?? { x: Math.abs(pos.y) > RAIL_EPS ? Math.round(pos.x) : gate.restX, y: 0 };
    slideAlongGate(pos, target, step);
  }

  function placeLevers(dt) {
    const color = RANGE_COLORS[range % RANGE_COLORS.length];
    slideAlongGate(knob, pos, KNOB_SPEED * dt);
    gearUnit.place(plateX(knob.x), -knob.y * ROW_SPACING);
    gearUnit.capMaterial.color.setHex(color);
    if (ranged()) {
      rangeUnit.place(rangeCx + RANGE_SLOT_OFFSET, rangeZ(rangePos));
      rangeUnit.capMaterial.color.setHex(color);
    }
  }

  function resize() {
    const width = Math.round(canvas.clientWidth);
    const height = Math.round(canvas.clientHeight);
    const key = `${width}x${height}`;
    if (!width || !height || key === sizeKey) return;
    sizeKey = key;
    renderer.setSize(width, height, false);
    frameCamera(width, height);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!gate || !shown) return;
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    dragging = ndcX > splitNdcX ? 'range' : 'gear';
    lastPointer = { x: e.clientX, y: e.clientY };
    Object.assign(hand, pos);
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || !gateEngine?.manual) return;
    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;
    lastPointer = { x: e.clientX, y: e.clientY };
    if (dragging === 'range') {
      const wanted = clamp(rangePos - dy / ((canvas.clientHeight || 1) * rangeFraction), 0, gate.ranges - 1);
      // The range shifts as the lever passes halfway to the next detent; a
      // range without the engaged main gear holds the lever short of it.
      setRange(Math.round(wanted), gateEngine);
      rangePos = clamp(wanted, range - 0.45, range + 0.45);
      return;
    }
    hand.x = clamp(hand.x + dx / ((canvas.clientWidth || 1) * columnFraction), -HAND_OVERSHOOT, gate.columns - 1 + HAND_OVERSHOOT);
    hand.y = clamp(hand.y - dy / ((canvas.clientHeight || 1) * rowFraction), -1 - HAND_OVERSHOOT, 1 + HAND_OVERSHOOT);
    followHand();
    // A refused gear knocks the knob back; the hand has to push again.
    if (selectFromLever(gateEngine)) Object.assign(hand, pos);
  });
  const endDrag = () => {
    dragging = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /**
   * Per frame. Shown while the vehicle's engine runs the manual box. `keys` /
   * `typing` from input.js for X / Z (range up / down).
   */
  function update(dt, { vehicle, keys, typing }) {
    const engine = vehicle?.engine;
    const manual = !!engine?.manual;
    const presses = engine?.autoShiftPresses ?? 0;
    if (engine !== pressEngine) {
      pressEngine = engine;
      pressesSeen = presses;
      lastGear = null;
      popupS = 0;
    }
    popupS = Math.max(0, popupS - dt);
    const popup = presses !== pressesSeen && !manual && !engine.automatic;
    pressesSeen = presses;
    if (popup) {
      const opening = popupS === 0;
      popupS = AUTO_SHIFT_SHOW_S;
      if (engine !== gateEngine) buildGate(engine);
      // Start from the gear before this shift, so the lever is seen moving.
      const from = opening && lastGear !== null ? gate.posForGear(lastGear) : null;
      if (from) {
        Object.assign(pos, { x: from.x, y: from.y });
        Object.assign(knob, pos);
      }
    }
    lastGear = engine?.gear ?? null;
    if (manual && engine !== gateEngine) buildGate(engine);
    if (manual || popupS > 0) range = engine.range;
    const rangeUp = !typing && keys.has('KeyX');
    const rangeDown = !typing && keys.has('KeyZ');
    if (manual && ranged()) {
      if (rangeUp && !rangeUpWasPressed) setRange(Math.min(gate.ranges - 1, range + 1), engine);
      if (rangeDown && !rangeDownWasPressed) setRange(Math.max(0, range - 1), engine);
    }
    rangeUpWasPressed = rangeUp;
    rangeDownWasPressed = rangeDown;

    const show = manual || popupS > 0;
    if (show !== shown) {
      shown = show;
      root.hidden = !show;
      if (!show) dragging = null;
    }
    root.classList.toggle('preview', !manual);
    if (!show) return;
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    }
    resize();
    followEngine(engine, dt);
    drawPlates(engine);
    placeLevers(dt);
    renderer.render(scene, camera);
  }

  return { update };
}
