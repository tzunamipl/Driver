// Engine sound profiles, picked by the descriptor's `engine` type.
// Pulse offsets are fractions of the four-stroke cycle relative to even spacing;
// unset tuning fields fall back to the defaults in engine.js.

// Lumpy, paired pulses read as a big lazy V8 rumble.
const V8 = {
  pulseOffsets: [0, 0.035, -0.012, 0.05],
  pulseAmps: [1, 0.72, 0.93, 0.66],
  pulseDecay: 0.03,
  pulseRing: 0.075,
  idleLope: 0.025,
  turbo: true,
};

// Subaru boxer with unequal-length headers: strongly paired, uneven pulses.
const BOXER = {
  pulseOffsets: [0, 0.085, -0.025, 0.105],
  pulseAmps: [1, 0.58, 0.95, 0.52],
  pulseDecay: 0.036,
  pulseRing: 0.085,
  idleLope: 0.035,
  bankMix: 0.7,
  bankDetune: 1.008,
  turbo: true,
};

// Inline four: even firing, short sharp pulses -> buzzy, raspy, revvy.
const INLINE4 = {
  pulseOffsets: [0, 0.004, -0.003, 0.002],
  pulseAmps: [1, 0.96, 0.98, 0.94],
  pulseDecay: 0.018,
  pulseRing: 0.05,
  idleLope: 0.01,
  bankMix: 0.25,
  bankDetune: 1.002,
  brightness: 1.35,
  turbo: true,
  whistlePitch: 1.15,
};

// Naturally aspirated inline four: same pulses, no turbo whistle or blow-off.
const INLINE4_NA = { ...INLINE4, turbo: false };

// Truck V6 diesel: even, heavy, dark pulses plus injection clatter; big slow
// turbo and no throttle plate, so no blow-off valve.
const V6_DIESEL = {
  pulseOffsets: [0, 0.008, -0.006, 0.005, -0.004, 0.01],
  pulseAmps: [1, 0.9, 0.95, 0.88, 0.97, 0.91],
  pulseDecay: 0.045,
  pulseRing: 0.11,
  idleLope: 0.012,
  body: 1.25,
  brightness: 0.6,
  hiss: 1.5,
  clatter: 1,
  turbo: true,
  whistlePitch: 0.55,
  blowOff: false,
};

export const ENGINE_SOUNDS = { v8: V8, v4: BOXER, r4: INLINE4, r4na: INLINE4_NA, v6d: V6_DIESEL };
export const DEFAULT_ENGINE_SOUND = V8;
