// Display units: metric or US imperial (Settings > Gameplay), remembered in localStorage.
// Simulation stays metric; everything shown to the player goes through these formatters.

import { UNITS_STORAGE_KEY } from '../config.js';

const KMH_PER_MPH = 1.609344;
export const M_PER_MILE = 1609.344;
export const FT_PER_M = 3.28084;
const YD_PER_M = 1.093613;
const L_PER_GAL = 3.785411784;
const LB_PER_KG = 2.204623;
const PSI_PER_BAR = 14.5038;
const LBFT_PER_NM = 0.737562;
const MM_PER_IN = 25.4;
const FEET_UP_TO_MILES = 0.1; // below this many miles, distances read in feet

function readUnits() {
  try {
    return localStorage.getItem(UNITS_STORAGE_KEY) === 'imperial' ? 'imperial' : 'metric';
  } catch {
    return 'metric';
  }
}

let units = readUnits();
const listeners = new Set();

export const getUnits = () => units;
export const isImperial = () => units === 'imperial';

/** 'metric' | 'imperial'; tells the listeners. */
export function setUnits(next) {
  const value = next === 'imperial' ? 'imperial' : 'metric';
  if (value === units) return;
  units = value;
  try { localStorage.setItem(UNITS_STORAGE_KEY, value); } catch { /* private mode */ }
  for (const fn of listeners) fn(units);
}

/** Calls `fn(units)` on every change; returns an unsubscribe. */
export function onUnitsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Value conversions (metric in, shown unit out) and unit labels.
export const speedValue = (kmh) => (isImperial() ? kmh / KMH_PER_MPH : kmh);
export const speedUnit = () => (isImperial() ? 'mph' : 'km/h');
/** Long distances (odometers, trip): km or miles. */
export const longDistanceValue = (km) => (isImperial() ? (km * 1000) / M_PER_MILE : km);
export const longDistanceUnit = () => (isImperial() ? 'mi' : 'km');
/** Short spans (pacenote calls, gaps): metres or yards. */
export const shortDistanceValue = (m) => (isImperial() ? m * YD_PER_M : m);
export const shortDistanceUnit = () => (isImperial() ? 'yd' : 'm');
export const tempValue = (c) => (isImperial() ? (c * 9) / 5 + 32 : c);
export const tempUnit = () => (isImperial() ? '°F' : '°C');
export const volumeValue = (l) => (isImperial() ? l / L_PER_GAL : l);
export const volumeUnit = () => (isImperial() ? 'gal' : 'L');
export const massValue = (kg) => (isImperial() ? kg * LB_PER_KG : kg);
export const massUnit = () => (isImperial() ? 'lb' : 'kg');
export const torqueValue = (nm) => (isImperial() ? nm * LBFT_PER_NM : nm);
export const torqueUnit = () => (isImperial() ? 'lb·ft' : 'Nm');
export const pressureValue = (bar) => (isImperial() ? bar * PSI_PER_BAR : bar);
export const pressureUnit = () => (isImperial() ? 'psi' : 'bar');
/** Shown value back to litres (e.g. a refuel slider in gallons). */
// US mpg = this / (L/100 km).
const MPG_X_L_PER_100KM = 235.215;
export const consumptionValue = (lPer100Km) => (isImperial() ? MPG_X_L_PER_100KM / lPer100Km : lPer100Km);
export const consumptionUnit = () => (isImperial() ? 'mpg' : 'L/100km');
export const litresFromVolume = (v) => (isImperial() ? v * L_PER_GAL : v);

export const formatSpeed = (kmh, digits = 0) => `${speedValue(kmh).toFixed(digits)} ${speedUnit()}`;
export const formatTemp = (c, digits = 0) => `${tempValue(c).toFixed(digits)} ${tempUnit()}`;
export const formatVolume = (l, digits = 1) => `${volumeValue(l).toFixed(digits)} ${volumeUnit()}`;
export const formatMass = (kg) => `${Math.round(massValue(kg))} ${massUnit()}`;
export const formatPressure = (bar, digits = 1) => `${pressureValue(bar).toFixed(isImperial() ? 0 : digits)} ${pressureUnit()}`;
export const formatRain = (mmH) => (isImperial() ? `${(mmH / MM_PER_IN).toFixed(2)} in/h` : `${mmH.toFixed(1)} mm/h`);
export const formatShortDistance = (m) => `${Math.round(shortDistanceValue(m))} ${shortDistanceUnit()}`;

/** HUD distance: metres up to 1 km then km (one decimal), or feet up to 0.1 mi then miles. */
export function formatDistance(m) {
  if (!isImperial()) return m > 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
  const miles = m / M_PER_MILE;
  return miles >= FEET_UP_TO_MILES ? `${miles.toFixed(1)} mi` : `${Math.round(m * FT_PER_M)} ft`;
}

/** Road-sign distance in km / miles: whole numbers, one decimal below 10. */
export function formatSignDistance(km) {
  const v = longDistanceValue(km);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${longDistanceUnit()}`;
}

/** Distance to another player: km (miles), then "kkm" / "k mi" (teleported peers may be continents away). */
export function formatPeerDistance(m) {
  const d = longDistanceValue(m / 1000);
  if (d >= 1000) {
    const k = d / 1000;
    return `${k.toFixed(k >= 10 ? 0 : 1)} ${isImperial() ? 'k mi' : 'kkm'}`;
  }
  return `${d >= 10 ? Math.round(d) : d.toFixed(1)} ${longDistanceUnit()}`;
}
