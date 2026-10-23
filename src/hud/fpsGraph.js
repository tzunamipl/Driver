// FPS over the last minute, a debug-view panel left of the players list. Records always (own rAF,
// like fpsCounter.js) so the history is there when the debug view opens; draws only while shown.

const SAMPLE_MS = 1000;
const HISTORY = 60; // samples
const MAX_GAP_MS = 1000; // longer frame gap = tab was hidden: restart the sample instead of logging a fake hitch
const WIDTH = 240;
const HEIGHT = 48;
const AVG_COLOR = '#1f9d2f';
const WORST_COLOR = 'rgba(214, 40, 40, 0.55)';
const GRID_COLOR = 'rgba(0, 0, 0, 0.18)';

export function createFpsGraph() {
  const canvas = document.getElementById('fps-graph');
  const label = document.getElementById('fps-graph-label');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const samples = []; // [{ avg, worst }] fps, oldest first

  let frames = 0;
  let longestMs = 0;
  let since = performance.now();
  let last = since;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(WIDTH * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    canvas.style.width = `${WIDTH}px`;
    canvas.style.height = `${HEIGHT}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function plot(key, color, top) {
    const step = WIDTH / (HISTORY - 1);
    const x0 = WIDTH - (samples.length - 1) * step; // newest at the right edge
    ctx.beginPath();
    samples.forEach((s, i) => {
      const y = HEIGHT - (Math.min(s[key], top) / top) * HEIGHT;
      if (i === 0) ctx.moveTo(x0, y);
      else ctx.lineTo(x0 + i * step, y);
    });
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  function draw() {
    // Hidden with the debug view (display: none on an ancestor).
    if (!canvas.offsetParent) return;
    if (canvas.width !== Math.round(WIDTH * (window.devicePixelRatio || 1))) resize();
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    const top = Math.max(60, Math.ceil(Math.max(...samples.map((s) => s.avg)) / 30) * 30);
    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID_COLOR;
    ctx.beginPath();
    for (let fps = 30; fps < top; fps += 30) {
      const y = Math.round(HEIGHT - (fps / top) * HEIGHT) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(WIDTH, y);
    }
    ctx.stroke();
    ctx.lineWidth = 1.5;
    plot('worst', WORST_COLOR, top);
    plot('avg', AVG_COLOR, top);
    if (label) {
      const now = samples[samples.length - 1];
      const min = Math.min(...samples.map((s) => s.avg));
      const avg = samples.reduce((sum, s) => sum + s.avg, 0) / samples.length;
      label.textContent = `fps ${Math.round(now.avg)}  min ${Math.round(min)}  avg ${Math.round(avg)}  worst frame ${Math.round(now.worst)}  (scale ${top})`;
    }
  }

  function tick(now) {
    const gap = now - last;
    last = now;
    if (gap > MAX_GAP_MS) {
      frames = 0;
      longestMs = 0;
      since = now;
    } else {
      frames++;
      longestMs = Math.max(longestMs, gap);
    }
    if (now - since >= SAMPLE_MS && frames > 0) {
      samples.push({ avg: (frames * 1000) / (now - since), worst: 1000 / longestMs });
      if (samples.length > HISTORY) samples.shift();
      frames = 0;
      longestMs = 0;
      since = now;
      draw();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
