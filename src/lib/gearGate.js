// H-gate layout for the manual gearstick: columns of fore/aft slots off a
// neutral rail, slot pairs 1-2, 3-4, ... and R last. Range-change boxes
// (engine.gearRanges > 1) repeat the same slots per range (LO/HI or
// LO/MID/HI, on a separate range lever).

import { NEUTRAL } from './engine.js';

function rangeLabels(count) {
  if (count === 2) return ['LO', 'HI'];
  if (count === 3) return ['LO', 'MID', 'HI'];
  return Array.from({ length: count }, (_, i) => `L${i + 1}`);
}

/**
 * Gate coordinates: x = column index (0..columns-1), y = +1 forward slot,
 * -1 back slot, 0 the neutral rail. Ranges are indices, 0 = lowest.
 */
export function createGearGate(gearCount, ranges) {
  const slots = Math.ceil(gearCount / ranges);
  // R shares the last pair's column when the slot count is odd, else gets its own.
  const columns = Math.ceil(slots / 2) + (slots % 2 === 0 ? 1 : 0);
  const reversePos = { x: columns - 1, y: slots % 2 === 0 ? 1 : -1 };

  function slotPos(slot) {
    return { x: Math.floor(slot / 2), y: slot % 2 === 0 ? 1 : -1 };
  }

  /** Gear at a slot end (x column, y ±1) in a range, or null for an empty spot. */
  function gearAt(x, y, range) {
    if (x === reversePos.x && y === reversePos.y) return 0;
    const slot = x * 2 + (y > 0 ? 0 : 1);
    if (slot >= slots) return null;
    const gear = slot + 1 + range * slots;
    return gear <= gearCount ? gear : null;
  }

  /** A physical slot end at (x, ±y); the lowest range fills every slot. */
  function hasSlot(x, y) {
    return y !== 0 && gearAt(x, Math.sign(y), 0) !== null;
  }

  /** Lever position for a gear, plus the range it needs (null for R / any). */
  function posForGear(gear) {
    if (gear === 0) return { ...reversePos, range: null };
    if (gear === NEUTRAL || gear == null) return null;
    return { ...slotPos((gear - 1) % slots), range: Math.floor((gear - 1) / slots) };
  }

  return {
    slots,
    ranges,
    rangeLabels: rangeLabels(ranges),
    columns,
    // Where the lever springs back to on the rail (the 3-4 plane where there is one).
    restX: Math.min(1, columns - 1),
    gearAt,
    hasSlot,
    posForGear,
  };
}
