// Shared dial geometry for the round gauges: angles are clockwise from 12
// o'clock, default sweep -90deg (min) to +90deg (max).

/** Needle/tick angle for `value` on a scale from min to max swept over startDeg..endDeg. */
export function valueToDeg(value, max, { min = 0, startDeg = -90, endDeg = 90 } = {}) {
  return startDeg + ((value - min) / (max - min)) * (endDeg - startDeg);
}

// Ticks + labels from min to max, rebuilt only when the scale changes (vehicle
// switch). Ticks rotate a full-dial wrapper about the dial centre; labels are
// placed by sin/cos instead so the numbers stay upright.
export function buildDialScale(container, { min = 0, max, step, minorStep = step, startDeg, endDeg, redFrom = Infinity, redBelow = -Infinity, label = String, labelRadiusPct }) {
  if (!container) return;
  container.innerHTML = '';
  const count = Math.floor((max - min) / minorStep + 1e-6);
  for (let i = 0; i <= count; i++) {
    const value = min + i * minorStep;
    const steps = (value - min) / step;
    const major = Math.abs(steps - Math.round(steps)) < 1e-6;
    const red = value >= redFrom || value <= redBelow ? ' redline' : '';
    const deg = valueToDeg(value, max, { min, startDeg, endDeg });

    const wrap = document.createElement('div');
    wrap.className = 'dial-tick-wrap';
    wrap.style.transform = `rotate(${deg}deg)`;
    const tick = document.createElement('div');
    tick.className = `dial-tick${major ? '' : ' minor'}${red}`;
    wrap.appendChild(tick);
    container.appendChild(wrap);
    if (!major) continue;

    const rad = (deg * Math.PI) / 180;
    const text = document.createElement('div');
    text.className = `dial-tick-label${red}`;
    text.textContent = label(value);
    text.style.left = `${50 + labelRadiusPct * Math.sin(rad)}%`;
    text.style.top = `${50 - labelRadiusPct * Math.cos(rad)}%`;
    container.appendChild(text);
  }
}
