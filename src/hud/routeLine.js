// Route polyline on a 2D map canvas (minimap + Navigation tab), in
// normalised Web Mercator so both maps share it whatever their zoom.

export const ROUTE_COLOR = '#2f7cff';
// Vertices closer than this (px) to the last drawn one are skipped.
const MIN_STEP_PX = 1.5;

/**
 * Strokes the part of `route` still ahead of `progress` (all of it if null).
 * (originMx, originMy) maps to the canvas' current (0, 0); `worldPx` = pixels per Mercator unit.
 */
export function strokeRoute(ctx, route, progress, originMx, originMy, worldPx, width) {
  const n = route.mx.length;
  if (n < 2) return;
  const toX = (mx) => (mx - originMx) * worldPx;
  const toY = (my) => (my - originMy) * worldPx;
  ctx.beginPath();
  let start = 0;
  if (progress) {
    const { index: i, t } = progress;
    start = i + 1;
    ctx.moveTo(toX(route.mx[i] + (route.mx[i + 1] - route.mx[i]) * t), toY(route.my[i] + (route.my[i + 1] - route.my[i]) * t));
  } else {
    ctx.moveTo(toX(route.mx[0]), toY(route.my[0]));
    start = 1;
  }
  let lastX = Infinity;
  let lastY = Infinity;
  for (let i = start; i < n; i++) {
    const x = toX(route.mx[i]);
    const y = toY(route.my[i]);
    if (i < n - 1 && Math.abs(x - lastX) < MIN_STEP_PX && Math.abs(y - lastY) < MIN_STEP_PX) continue;
    ctx.lineTo(x, y);
    lastX = x;
    lastY = y;
  }
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = width + 3;
  ctx.stroke();
  ctx.strokeStyle = ROUTE_COLOR;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}
