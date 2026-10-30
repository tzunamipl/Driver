// Debug-view weather: forecast readout, road Live / Dry / Damp / Wet (surface wetness: wet road
// look + tyre wet grip; Live = from the forecast's last day, weatherFeed.js), a cloud preset
// override, a rainfall override, a fog (visibility) override and an air temperature override (Live or a slider).
// The choices persist.

import { WEATHER_DEBUG_STORAGE_KEY } from '../config.js';
import { formatTemp, formatRain } from '../lib/units.js';
import { rainVisibilityM } from '../app/weatherFog.js';
import {
  CLOUD_PRESETS,
  NO_FOG_VISIBILITY_M,
  getAirTempC,
  getAirTempOverrideC,
  getCloudPreset,
  getForecast,
  getRainMmH,
  getRainOverrideMmH,
  getVisibilityM,
  getVisibilityOverrideM,
  getWetness,
  onWeatherChange,
  setAirTempOverrideC,
  setRainOverrideMmH,
  setVisibilityOverrideM,
  setWetness,
} from '../lib/weather.js';

const ROAD = [
  { live: true, label: 'Live' },
  { wetness: 0, label: 'Dry' },
  { wetness: 0.5, label: 'Damp' },
  { wetness: 1, label: 'Wet' },
];
const RAIN = [
  { mmH: null, label: 'Live' },
  { mmH: 0, label: 'None' },
  { mmH: 1, label: 'Light' },
  { mmH: 4, label: 'Moderate' },
  { mmH: 10, label: 'Heavy' },
];
const FOG = [
  { m: null, label: 'Live' },
  { m: NO_FOG_VISIBILITY_M, label: 'None' },
  { m: 8_000, label: 'Haze' },
  { m: 2_000, label: 'Mist' },
  { m: 400, label: 'Fog' },
  { m: 100, label: 'Dense' },
];
const TEMP_MIN_C = -25;
const TEMP_MAX_C = 45;
const CLOUDS = [{ id: null, label: 'Live' }, ...CLOUD_PRESETS.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }))];

function load() {
  try {
    return JSON.parse(localStorage.getItem(WEATHER_DEBUG_STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function save(saved) {
  try {
    localStorage.setItem(WEATHER_DEBUG_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Storage unavailable: just don't persist.
  }
}

function buttonRow(listEl, items, onPick) {
  return items.map((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'debug-time-btn';
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      onPick(item);
      btn.blur(); // keep keyboard driving working after a click
    });
    listEl.append(btn);
    return btn;
  });
}

/**
 * @param {HTMLElement} hudEl - #debug-weather-hud
 * @param {{ setCloudOverride: (id: string | null) => void, getCloudOverride: () => string | null, hasForecast: () => boolean,
 *   setLiveWetness: (on: boolean) => void, getLiveWetness: () => boolean }} weatherFeed
 */
export function createWeatherDebug(hudEl, weatherFeed) {
  const readoutEl = hudEl.querySelector('.debug-weather-readout');
  const saved = load();
  if (saved.wetness === 'live') weatherFeed.setLiveWetness(true);
  else if (Number.isFinite(saved.wetness)) setWetness(saved.wetness);
  if (CLOUD_PRESETS.includes(saved.clouds)) weatherFeed.setCloudOverride(saved.clouds);
  if (Number.isFinite(saved.tempC)) setAirTempOverrideC(saved.tempC);
  if (Number.isFinite(saved.rainMmH)) setRainOverrideMmH(saved.rainMmH);
  if (Number.isFinite(saved.visibilityM)) setVisibilityOverrideM(saved.visibilityM);

  const roadButtons = buttonRow(hudEl.querySelector('.debug-weather-road'), ROAD, ({ live, wetness }) => {
    weatherFeed.setLiveWetness(!!live);
    if (!live) setWetness(wetness);
    save({ ...load(), wetness: live ? 'live' : wetness });
    sync();
  });
  const cloudButtons = buttonRow(hudEl.querySelector('.debug-weather-clouds'), CLOUDS, ({ id }) => {
    weatherFeed.setCloudOverride(id);
    save({ ...load(), clouds: id });
    sync();
  });
  const rainButtons = buttonRow(hudEl.querySelector('.debug-weather-rain'), RAIN, ({ mmH }) => {
    setRainOverrideMmH(mmH);
    save({ ...load(), rainMmH: mmH });
    sync();
  });

  const fogButtons = buttonRow(hudEl.querySelector('.debug-weather-fog'), FOG, ({ m }) => {
    setVisibilityOverrideM(m);
    save({ ...load(), visibilityM: m });
    sync();
  });

  const tempEl = hudEl.querySelector('.debug-weather-temp');
  const [tempLiveButton] = buttonRow(tempEl, [{ label: 'Live' }], () => {
    setAirTempOverrideC(null);
    save({ ...load(), tempC: null });
  });
  const tempSlider = document.createElement('input');
  Object.assign(tempSlider, { type: 'range', min: TEMP_MIN_C, max: TEMP_MAX_C, step: 1 });
  const tempValueEl = document.createElement('span');
  tempValueEl.className = 'debug-weather-temp-value';
  tempEl.append(tempSlider, tempValueEl);
  tempSlider.addEventListener('input', () => {
    const tempC = Number(tempSlider.value);
    setAirTempOverrideC(tempC);
    save({ ...load(), tempC });
  });
  tempSlider.addEventListener('change', () => tempSlider.blur()); // keep keyboard driving working

  function sync() {
    const wetness = getWetness();
    const live = weatherFeed.getLiveWetness();
    roadButtons.forEach((btn, i) => btn.classList.toggle('active', live ? !!ROAD[i].live : ROAD[i].wetness === wetness));
    const override = weatherFeed.getCloudOverride();
    cloudButtons.forEach((btn, i) => btn.classList.toggle('active', CLOUDS[i].id === override));
    const forcedRain = getRainOverrideMmH();
    rainButtons.forEach((btn, i) => btn.classList.toggle('active', RAIN[i].mmH === forcedRain));
    const forcedFog = getVisibilityOverrideM();
    fogButtons.forEach((btn, i) => btn.classList.toggle('active', FOG[i].m === forcedFog));

    const forcedTempC = getAirTempOverrideC();
    tempLiveButton.classList.toggle('active', forcedTempC == null);
    if (document.activeElement !== tempSlider) tempSlider.value = String(Math.round(getAirTempC()));
    tempValueEl.textContent = forcedTempC == null ? 'live' : `${forcedTempC} °C`;

    const f = getForecast();
    const sky = override ? `${getCloudPreset()} (forced; forecast ${f?.clouds ?? '?'})` : getCloudPreset();
    const cover = f ? `\ncloud low/mid/high ${Math.round(f.cover.low)}/${Math.round(f.cover.mid)}/${Math.round(f.cover.high)} %  rain ${formatRain(f.precipMm)}` : '';
    const source = weatherFeed.hasForecast() ? 'Open-Meteo' : 'no forecast, defaults';
    const road = live ? `\nroad wetness ${Math.round(wetness * 100)} % (live)` : '';
    const temp = forcedTempC == null ? formatTemp(getAirTempC(), 1) : `${formatTemp(getAirTempC(), 1)} (forced)`;
    const rain = `\nrainfall ${formatRain(getRainMmH())}${forcedRain == null ? '' : ' (forced)'}`;
    const distText = (m) => (m >= NO_FOG_VISIBILITY_M ? 'clear' : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
    const rainHazeM = rainVisibilityM(getRainMmH());
    const fog = `\nvisibility ${distText(getVisibilityM())}${forcedFog == null ? '' : ' (forced)'}${rainHazeM < NO_FOG_VISIBILITY_M ? `, rain ${distText(rainHazeM)}` : ''}`;
    readoutEl.textContent = `${temp}  ${sky}  [${source}]${cover}${road}${rain}${fog}`;
  }

  onWeatherChange(sync);
  sync();
}
