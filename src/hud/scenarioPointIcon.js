// Scenario point icon on a 2D map canvas (minimap + Navigation tab), for the editor and the
// rally plan: gates as labelled rounded squares (widened to fit longer labels), other points
// (rally base) as discs. Done points are faded.

/** Draws the points, done first and selected last so it sits on top; `toScreen` returns null to skip one. */
export function drawScenarioPoints(ctx, points, toScreen, scale = 1) {
  if (!points.length) return;
  const r = 6 * scale;
  ctx.save();
  ctx.font = `700 ${Math.round(8 * scale)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const ordered = [
    ...points.filter((p) => p.done && !p.selected),
    ...points.filter((p) => !p.done && !p.selected),
    ...points.filter((p) => p.selected),
  ];
  for (const point of ordered) {
    const pos = toScreen(point.lat, point.lon);
    if (!pos) continue;
    const { x, y } = pos;
    ctx.globalAlpha = point.done ? 0.45 : 1;
    ctx.beginPath();
    const halfW = Math.max(r, ctx.measureText(point.label).width / 2 + 2.5 * scale);
    if (point.gate || halfW > r) ctx.roundRect(x - halfW, y - r, halfW * 2, r * 2, 2 * scale);
    else ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `#${(point.color & 0xffffff).toString(16).padStart(6, '0')}`;
    ctx.strokeStyle = point.selected ? '#1a1a1a' : '#ffffff';
    ctx.lineWidth = (point.selected ? 2.5 : 1.5) * scale;
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 2 * scale;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeText(point.label, x, y + 0.5 * scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(point.label, x, y + 0.5 * scale);
  }
  ctx.restore();
}
