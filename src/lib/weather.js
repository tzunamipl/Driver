// Current weather, read by gameplay and visuals: outside air temperature (engine heat,
// tyre temps), surface wetness (tyre wet grip floor, wet road look), the cloud preset,
// rainfall (rain.js) and visibility (fog, app/weatherFog.js). Fed by app/weatherFeed.js (forecast), app/rally/rallyConditions.js
// and the debug weather controls; the config values hold until the first forecast arrives.

import { AMBIENT_TEMP_C, WEATHER_WETNESS } from '../config.js';

// Sky presets, clearest first (clouds.js draws them).
export const CLOUD_PRESETS = ['clear', 'fair', 'cumulus', 'cirrus', 'patchy', 'broken', 'overcast'];
// Visibility (m) standing for "no fog": finite, so it lerps and saves as JSON.
export const NO_FOG_VISIBILITY_M = 50_000;

const state = {
  airTempC: AMBIENT_TEMP_C,
  airTempOverrideC: null, // debug: wins over every feed
  wetness: WEATHER_WETNESS,
  clouds: 'cumulus',
  rainMmH: 0,
  rainOverrideMmH: null, // debug: wins over every feed
  visibilityM: NO_FOG_VISIBILITY_M,
  visibilityOverrideM: null, // debug: wins over every feed
  // Forecast extras for the debug readout: { tempC, clouds, precipMm, visibilityM, cover: { low, mid, high } } or null.
  forecast: null,
};
const listeners = new Set();

function changed() {
  for (const fn of listeners) fn(state);
}

export const getAirTempC = () => state.airTempOverrideC ?? state.airTempC;
export const getWetness = () => state.wetness;
export const getCloudPreset = () => state.clouds;
export const getForecast = () => state.forecast;
export const getRainMmH = () => state.rainOverrideMmH ?? state.rainMmH;
export const getVisibilityM = () => state.visibilityOverrideM ?? state.visibilityM;

export function setAirTempC(tempC) {
  if (!Number.isFinite(tempC) || tempC === state.airTempC) return;
  state.airTempC = tempC;
  changed();
}

/** Debug: force the air temperature (°C), or null to follow the feeds again. */
export function setAirTempOverrideC(tempC) {
  const next = Number.isFinite(tempC) ? tempC : null;
  if (next === state.airTempOverrideC) return;
  state.airTempOverrideC = next;
  changed();
}

export const getAirTempOverrideC = () => state.airTempOverrideC;

/** 0 dry .. 1 soaked. */
export function setWetness(wetness) {
  const w = Math.min(1, Math.max(0, wetness));
  if (w === state.wetness) return;
  state.wetness = w;
  changed();
}

export function setCloudPreset(preset) {
  if (!CLOUD_PRESETS.includes(preset) || preset === state.clouds) return;
  state.clouds = preset;
  changed();
}

/** Rainfall in mm/h (0 = none). */
export function setRainMmH(mmH) {
  const r = Number.isFinite(mmH) ? Math.max(0, mmH) : 0;
  if (r === state.rainMmH) return;
  state.rainMmH = r;
  changed();
}

/** Debug: force the rainfall (mm/h), or null to follow the feeds again. */
export function setRainOverrideMmH(mmH) {
  const next = Number.isFinite(mmH) ? Math.max(0, mmH) : null;
  if (next === state.rainOverrideMmH) return;
  state.rainOverrideMmH = next;
  changed();
}

export const getRainOverrideMmH = () => state.rainOverrideMmH;

/** Visibility in metres (NO_FOG_VISIBILITY_M or more = clear air). */
export function setVisibilityM(m) {
  const v = Number.isFinite(m) ? Math.min(NO_FOG_VISIBILITY_M, Math.max(1, m)) : NO_FOG_VISIBILITY_M;
  if (v === state.visibilityM) return;
  state.visibilityM = v;
  changed();
}

/** Debug: force the visibility (m), or null to follow the feeds again. */
export function setVisibilityOverrideM(m) {
  const next = Number.isFinite(m) ? Math.min(NO_FOG_VISIBILITY_M, Math.max(1, m)) : null;
  if (next === state.visibilityOverrideM) return;
  state.visibilityOverrideM = next;
  changed();
}

export const getVisibilityOverrideM = () => state.visibilityOverrideM;

export function setForecast(forecast) {
  state.forecast = forecast;
  changed();
}

/** Calls `fn(state)` on every change; returns an unsubscribe. */
export function onWeatherChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
