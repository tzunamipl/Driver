// Pacenote icon shapes, shared by the HUD strip (SVG) and the editor's world tiles (canvas):
// an arrow up from the bottom bent by the grade, straight for 'S', and a junction fork.
// Path data in a -20..20 box (arrow, crest profiles) / 0..20 x 0..24 (fork) / 0..40 x 0..36 (warning signs).
// Surface calls get a swatch of the surface instead; crest calls the road's profile over the top
// (a jump: a kick and the flight, dashed). A note's warning sign (noteSign: steep descent or care) sits beside its call.

import { STAGE_SURFACES } from './stageSurfaces.js';

// Degrees the arrow turns through, per grade.
const ARROW_TURN = { 1: 165, 2: 130, 3: 100, 4: 75, 5: 50, 6: 28 };
const STEM = 12; // units straight before the bend
const BEND = 16; // units along the bend
const HEAD = 5;
const BEND_STEPS = 12;
const STRAIGHT = { line: 'M0 16 L0 -10', head: 'M0 -16 L-4 -9 L4 -9 Z' };
export const ARROW_VIEWBOX = '-20 -22 40 40';
export const FORK_PATH = 'M10 22 V13 M10 13 L4 3 M10 13 L16 3';
const CREST_PATHS = {
  crest: { line: 'M-18 12 C-8 12 -7 -6 0 -6 C7 -6 8 12 18 12' },
  jump: { line: 'M-18 12 C-10 12 -7 -1 -3 -1 L-3 12 M7 12 L18 12', flight: 'M-3 -1 Q5 -16 13 8' },
};
export const SIGN_VIEWBOX = '0 0 40 36';
export const SIGN_TRIANGLE = 'M20 3 L37 33 L3 33 Z';
// The slope: a black triangle on the board's inner base up to its left inner edge (white margin all round)...
export const SIGN_SLOPE = 'M14.9 18.7 L8.7 29.7 L31.3 29.7 Z';
// ...and a car going down it: path in its own frame (x along the slope, wheels on y = 0), placed by SIGN_CAR_AT.
export const SIGN_CAR =
  'M-4.5 -1 L-4.5 -2.2 L-2.5 -2.5 L-1.2 -4 L2 -4 L3.3 -2.5 L4.5 -2.2 L4.5 -1 Z ' +
  'M-1.6 -1 A1 1 0 1 1 -3.6 -1 A1 1 0 1 1 -1.6 -1 Z M3.6 -1 A1 1 0 1 1 1.6 -1 A1 1 0 1 1 3.6 -1 Z';
export const SIGN_CAR_AT = { x: 21.8, y: 23.3, deg: 33.8, scale: 0.85 };
export const SIGN_RED = '#e01010';
// Care: an exclamation mark, a tapering bar and a dot.
export const SIGN_EXCLAIM = 'M18.1 11 L21.9 11 L21 23.5 L19 23.5 Z M22 28 A2 2 0 1 1 18 28 A2 2 0 1 1 22 28 Z';

/** The warning sign beside a note's call: 'care' | 'descent' | null (one at most, care first). */
export const noteSign = (note) => (note.caution ? 'care' : note.descent ? 'descent' : null);

/** { line, flight? } SVG path data for a crest call's profile. */
export const crestPaths = (note) => CREST_PATHS[note.crest];

/** { line, head } SVG path data for a note's arrow. */
export function arrowPaths(note) {
  if (note.dir === 'S') return STRAIGHT;
  const side = note.dir === 'L' ? -1 : 1;
  const pts = [[0, 16], [0, 16 - STEM]];
  let [x, y] = pts[1];
  let heading = -Math.PI / 2; // up
  const turn = ((ARROW_TURN[note.grade] * Math.PI) / 180) * side;
  for (let k = 0; k < BEND_STEPS; k++) {
    heading += turn / BEND_STEPS;
    x += (Math.cos(heading) * BEND) / BEND_STEPS;
    y += (Math.sin(heading) * BEND) / BEND_STEPS;
    pts.push([x, y]);
  }
  const cx = Math.cos(heading);
  const cy = Math.sin(heading);
  const tip = [x + cx * HEAD, y + cy * HEAD];
  const wing = (s) => [x - cy * HEAD * 0.8 * s, y + cx * HEAD * 0.8 * s];
  const f = (p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
  return { line: `M${pts.map(f).join(' L')}`, head: `M${f(tip)} L${f(wing(1))} L${f(wing(-1))} Z` };
}

const TILE_W = 128;
const TILE_H = 168;
const BORDER = 6;
const ARROW_PX = 72;
const FORK_PX = 22;
const SIGN_PX = 46;
const SIGN_GAP = 6;

/** Arrow, or a crest call's profile, in the arrow's box. */
function drawArrow(ctx, note, accent) {
  const { line, head, flight } = note.crest ? crestPaths(note) : arrowPaths(note);
  ctx.save();
  ctx.translate(TILE_W / 2, 14 + ARROW_PX / 2);
  ctx.scale(ARROW_PX / 40, ARROW_PX / 40);
  ctx.translate(0, 2); // the box runs -22..18
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D(line));
  if (head) ctx.fill(new Path2D(head));
  if (flight) {
    ctx.lineWidth = 2.5;
    ctx.setLineDash([3, 4]);
    ctx.stroke(new Path2D(flight));
  }
  ctx.restore();
}

/** Warning sign ('care' | 'descent') SIGN_PX wide with its top-left at (x, y). */
function drawSign(ctx, sign, x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(SIGN_PX / 40, SIGN_PX / 40);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = SIGN_RED;
  ctx.lineWidth = 3.5;
  ctx.lineJoin = 'round';
  const triangle = new Path2D(SIGN_TRIANGLE);
  ctx.fill(triangle);
  ctx.stroke(triangle);
  ctx.fillStyle = '#000000';
  if (sign === 'care') {
    ctx.fill(new Path2D(SIGN_EXCLAIM));
    ctx.restore();
    return;
  }
  ctx.fill(new Path2D(SIGN_SLOPE));
  const { x: cx, y: cy, deg, scale } = SIGN_CAR_AT;
  ctx.translate(cx, cy);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.scale(scale, scale);
  ctx.fill(new Path2D(SIGN_CAR));
  ctx.restore();
}

/** Surface call: a square of the surface's colour where the arrow goes. */
function drawSurfaceSwatch(ctx, surface, accent) {
  const size = ARROW_PX * 0.7;
  const x = (TILE_W - size) / 2;
  const y = 14 + (ARROW_PX - size) / 2;
  ctx.fillStyle = STAGE_SURFACES[surface].color;
  ctx.fillRect(x, y, size, size);
  ctx.lineWidth = 4;
  ctx.strokeStyle = accent;
  ctx.strokeRect(x, y, size, size);
}

/**
 * Canvas tile like the HUD's: arrow, call (e.g. 'R4') and what follows ('100', 'into'),
 * a fork at junctions. `selected` = yellow, `hover` = white outline.
 */
export function noteTileCanvas({ note, call, gap, selected, hover }) {
  const canvas = document.createElement('canvas');
  canvas.width = TILE_W;
  canvas.height = TILE_H;
  const ctx = canvas.getContext('2d');
  const accent = selected ? '#f6c900' : '#ffffff';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
  ctx.fillRect(0, 0, TILE_W, TILE_H);
  ctx.lineWidth = BORDER;
  ctx.strokeStyle = hover ? '#ffffff' : selected ? '#f6c900' : '#888888';
  ctx.strokeRect(BORDER / 2, BORDER / 2, TILE_W - BORDER, TILE_H - BORDER);

  if (note.surface) drawSurfaceSwatch(ctx, note.surface, accent);
  else drawArrow(ctx, note, accent);

  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // A warning sign sits right of the call; the pair stays centred, the call shrunk to fit beside it.
  const sign = noteSign(note);
  const signW = sign ? SIGN_PX + SIGN_GAP : 0;
  let fontPx = note.dir === 'S' || note.surface || note.crest ? 24 : 34;
  ctx.font = `bold ${fontPx}px monospace`;
  while (fontPx > 12 && ctx.measureText(call).width + signW > TILE_W - BORDER * 2 - 8) ctx.font = `bold ${(fontPx -= 2)}px monospace`;
  const callW = ctx.measureText(call).width;
  const callX = TILE_W / 2 - signW / 2;
  ctx.fillText(call, callX, 112);
  if (sign) drawSign(ctx, sign, callX + callW / 2 + SIGN_GAP, 112 - (SIGN_PX * 0.9) / 2);
  ctx.font = '22px sans-serif';
  const gapWidth = ctx.measureText(gap).width;
  const forkGap = note.junction ? FORK_PX * 0.6 : 0;
  const gapX = TILE_W / 2 - forkGap / 2;
  ctx.fillStyle = '#dddddd';
  ctx.fillText(gap, gapX, 145);
  if (note.junction) {
    ctx.save();
    ctx.translate(gapX + gapWidth / 2 + 4, 145 - FORK_PX / 2);
    ctx.scale(FORK_PX / 24, FORK_PX / 24);
    ctx.strokeStyle = '#dddddd';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke(new Path2D(FORK_PATH));
    ctx.restore();
  }
  return canvas;
}
