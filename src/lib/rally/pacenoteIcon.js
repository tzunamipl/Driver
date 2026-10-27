// Pacenote icon shapes, shared by the HUD strip (SVG) and the editor's world tiles (canvas):
// an arrow up from the bottom bent by the grade, straight for 'S', and a junction fork.
// Path data in a -20..20 box (arrow) / 0..20 x 0..24 (fork). Surface calls get a swatch of the surface instead.

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

function drawArrow(ctx, note, accent) {
  const { line, head } = arrowPaths(note);
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
  ctx.fill(new Path2D(head));
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
  ctx.font = `bold ${note.dir === 'S' || note.surface ? 24 : 34}px monospace`;
  ctx.fillText(call, TILE_W / 2, 112);
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
