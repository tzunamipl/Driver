// FIA control-zone board faces, drawn on canvas: yellow = zone ahead, red = the control,
// beige with three bars = zone end. Symbols per control kind; textures cached and shared.

import { CanvasTexture, SRGBColorSpace } from 'three';

const SIZE = 256;
export const BOARD_COLORS = { yellow: '#f6c900', red: '#d71e1e', beige: '#e6d6ad' };

function drawClock(ctx, fg) {
  ctx.strokeStyle = fg;
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, 78, 0, Math.PI * 2);
  ctx.moveTo(SIZE / 2, SIZE / 2);
  ctx.lineTo(SIZE / 2, SIZE / 2 - 56);
  ctx.moveTo(SIZE / 2, SIZE / 2);
  ctx.lineTo(SIZE / 2 + 42, SIZE / 2 + 18);
  ctx.stroke();
}

function drawChequered(ctx) {
  const cells = 4;
  const cell = 34;
  const x0 = SIZE / 2 - (cells * cell) / 2 + 10;
  const y0 = 56;
  ctx.fillStyle = '#fff';
  ctx.fillRect(x0, y0, cells * cell, cells * cell * 0.75);
  ctx.fillStyle = '#000';
  for (let r = 0; r < 3; r++) for (let c = 0; c < cells; c++) if ((r + c) % 2 === 0) ctx.fillRect(x0 + c * cell, y0 + r * cell * 0.75, cell, cell * 0.75);
  ctx.fillRect(x0 - 12, y0, 10, 150); // flag pole
}

function drawText(ctx, text, fg) {
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = 110;
  do ctx.font = `bold ${(size -= 6)}px sans-serif`;
  while (ctx.measureText(text).width > SIZE - 40 && size > 30);
  ctx.fillText(text, SIZE / 2, SIZE / 2);
}

const cache = new Map();

/**
 * @param {'yellow' | 'red' | 'beige'} color
 * @param {string} symbol - 'clock', 'chequered', or text to print (e.g. 'STOP', 'PC').
 */
export function boardTexture(color, symbol) {
  const key = `${color}|${symbol}`;
  let texture = cache.get(key);
  if (texture) return texture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BOARD_COLORS[color];
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#111';
  ctx.strokeRect(5, 5, SIZE - 10, SIZE - 10);
  const fg = color === 'red' ? '#fff' : '#111';
  if (symbol === 'clock') drawClock(ctx, fg);
  else if (symbol === 'chequered') drawChequered(ctx);
  else drawText(ctx, symbol, fg);
  if (color === 'beige') {
    // Zone end: three diagonal bars over the symbol.
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 14;
    for (const off of [-50, 0, 50]) {
      ctx.beginPath();
      ctx.moveTo(40 + off, SIZE - 40);
      ctx.lineTo(SIZE - 40 + off, 40);
      ctx.stroke();
    }
  }
  texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  cache.set(key, texture);
  return texture;
}

/** Banner text texture (arches, flags): white text on `bg`. */
export function bannerTexture(text, bg, width = 512, height = 128) {
  const key = `banner|${text}|${bg}|${width}x${height}`;
  let texture = cache.get(key);
  if (texture) return texture;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(height * 0.6)}px sans-serif`;
  ctx.fillText(text, width / 2, height / 2);
  texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  cache.set(key, texture);
  return texture;
}
