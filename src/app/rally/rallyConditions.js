// Rally clock and weather. A rally's day 1 starts at its start time (local to the rally) on
// the day it was picked and runs at real speed; time jumps (service, field fixes, skipped
// liaisons, tyres, refuel) add to it, and each parc fermé ends the day: the next one starts
// at that point's `nextStart`. Weather comes from forecast snapshots taken when the rally
// starts (lib/rally/rallyWeather.js), with road wetness carried through every jump.
// A single stage instead runs from a picked time of day (or now) in fixed weather, or in the
// forecast weather like a rally.
// Drives daylight.js (setClock) and lib/weather.js while a plan is up.

import { presetTimeMs } from '../daylight.js';
import { classifyClouds } from '../weatherFeed.js';
import { setAirTempC, setCloudPreset, setWetness, setRainMmH, setVisibilityM, NO_FOG_VISIBILITY_M } from '../../lib/weather.js';
import { MS_PER_DAY, localDayStart, guessUtcOffsetSec, fetchUtcOffsetSec, fetchRallyWeather, sampleWeather, integrateWetness } from '../../lib/rally/rallyWeather.js';
import { AMBIENT_TEMP_C, WEATHER_WETNESS } from '../../config.js';

const APPLY_INTERVAL_MS = 2_000; // weather pushed out and wetness carried on this often (game time)
const OVERCAST_RAIN_MM_H = 0.5; // this much rain always comes from an overcast sky
const SHOWN_RAIN_MM_H = 0.1; // less is too little to draw
const OFFLINE_CLOUDS = 'fair';

export const STAGE_TIMES = [
  { id: 'live', label: 'Live (now)' },
  { id: 'morning', label: 'Morning', tempC: -4 },
  { id: 'noon', label: 'Noon', tempC: 0 },
  { id: 'sunset', label: 'Sunset', tempC: -3 },
  { id: 'night', label: 'Night', tempC: -8 },
];
export const STAGE_WEATHER = [
  { id: 'live', label: 'Live (forecast)' },
  { id: 'sunny', label: 'Sunny', clouds: 'clear', wetness: 0, rainMmH: 0, tempC: 22 },
  { id: 'damp', label: 'Damp', clouds: 'cumulus', wetness: 0.5, rainMmH: 0, tempC: 14 },
  { id: 'rain', label: 'Rain', clouds: 'overcast', wetness: 1, rainMmH: 4, tempC: 11 },
];
export const DEFAULT_STAGE_CONDITIONS = { timeOfDay: 'noon', weather: 'sunny' };

/** A preset's temperature offset; live time takes the preset nearest to `timeMs` today. */
function timeTempC(time, timeMs, lat, lon) {
  if (time.id !== 'live') return time.tempC;
  const presets = STAGE_TIMES.filter((t) => t.id !== 'live');
  const off = (t) => {
    const d = (((presetTimeMs(t.id, lat, lon, timeMs) - timeMs) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
    return Math.min(d, MS_PER_DAY - d);
  };
  return presets.reduce((best, t) => (off(t) < off(best) ? t : best)).tempC;
}

/**
 * @param {object} deps
 * @param {(clock: (() => number) | null) => void} deps.setClock - daylight.js setClock.
 * @param {(on: boolean) => void} deps.setLiveWeather - the free-roam forecast feed on / off.
 */
export function createRallyConditions({ setClock, setLiveWeather }) {
  // { kind: 'rally' | 'stage', lat, lon, utcOffsetSec, firstDayMs (local midnight of day 1), day, timeMs, wetness,
  //   snapshots (rally), fixed: { clouds, wetness, rainMmH, tempC } (stage) } | null
  let state = null;
  let appliedAt = -Infinity;
  let carriedTo = 0; // wetness carried on up to this instant

  function take(next) {
    state = next;
    carriedTo = state.timeMs;
    appliedAt = -Infinity;
    setLiveWeather(false);
    setClock(() => state.timeMs);
    apply();
  }

  function carryWetness() {
    if (state.timeMs <= carriedTo) return;
    state.wetness = integrateWetness(state.wetness, carriedTo, state.timeMs, state.snapshots, state.lat, state.lon);
    carriedTo = state.timeMs;
  }

  function apply() {
    appliedAt = state.timeMs;
    if (state.fixed) {
      const { clouds, wetness, rainMmH, tempC } = state.fixed;
      setAirTempC(tempC);
      setCloudPreset(clouds);
      setWetness(wetness);
      setRainMmH(rainMmH);
      setVisibilityM(NO_FOG_VISIBILITY_M);
      return;
    }
    carryWetness();
    setWetness(state.wetness);
    const w = sampleWeather(state.snapshots, state.timeMs);
    if (!w) {
      setAirTempC(AMBIENT_TEMP_C);
      setCloudPreset(OFFLINE_CLOUDS);
      setRainMmH(0);
      setVisibilityM(NO_FOG_VISIBILITY_M);
      return;
    }
    setAirTempC(Math.round(w.tempC * 10) / 10);
    setVisibilityM(w.visibilityM);
    setCloudPreset(w.precipMmH >= OVERCAST_RAIN_MM_H ? 'overcast' : classifyClouds({ ...w.cover, code: w.code }));
    setRainMmH(w.precipMmH >= SHOWN_RAIN_MM_H ? w.precipMmH : 0);
  }

  return {
    /**
     * A new rally at lat/lon: day 1 is today (local to the rally) from `startMin`; the forecast covers `days` days.
     * Offline it runs on the config weather.
     */
    async startRally({ lat, lon, startMin, days }) {
      let utcOffsetSec = guessUtcOffsetSec(lon);
      let snapshots = [];
      try {
        ({ utcOffsetSec, snapshots } = await fetchRallyWeather(lat, lon, localDayStart(Date.now(), utcOffsetSec), days));
      } catch (err) {
        console.warn('Rally weather unavailable:', err.message);
      }
      const firstDayMs = localDayStart(Date.now(), utcOffsetSec);
      const timeMs = firstDayMs + startMin * 60_000;
      // The road starts as the last day's weather left it.
      const wetness = snapshots.length ? integrateWetness(0, timeMs - MS_PER_DAY, timeMs, snapshots, lat, lon) : WEATHER_WETNESS;
      take({ kind: 'rally', lat, lon, utcOffsetSec, firstDayMs, day: 1, timeMs, wetness, snapshots, fixed: null });
    },

    /** A single stage at lat/lon today: from a STAGE_TIMES instant (live = now), in STAGE_WEATHER (live = the forecast). */
    async startStage({ lat, lon, timeOfDay, weather }) {
      const time = STAGE_TIMES.find((t) => t.id === timeOfDay) ?? STAGE_TIMES.find((t) => t.id === 'noon');
      const sky = STAGE_WEATHER.find((w) => w.id === weather) ?? STAGE_WEATHER.find((w) => w.id === 'sunny');
      const now = Date.now();
      const timeMs = time.id === 'live' ? now : presetTimeMs(time.id, lat, lon, now);
      if (sky.id === 'live') {
        let utcOffsetSec = guessUtcOffsetSec(lon);
        let snapshots = [];
        try {
          ({ utcOffsetSec, snapshots } = await fetchRallyWeather(lat, lon, localDayStart(timeMs, utcOffsetSec), 1));
        } catch (err) {
          console.warn('Stage weather unavailable:', err.message);
        }
        const wetness = snapshots.length ? integrateWetness(0, timeMs - MS_PER_DAY, timeMs, snapshots, lat, lon) : WEATHER_WETNESS;
        take({ kind: 'stage', lat, lon, utcOffsetSec, firstDayMs: localDayStart(timeMs, utcOffsetSec), day: 1, timeMs, wetness, snapshots, fixed: null });
        return;
      }
      const utcOffsetSec = guessUtcOffsetSec(lon);
      const fixed = { clouds: sky.clouds, wetness: sky.wetness, rainMmH: sky.rainMmH, tempC: sky.tempC + timeTempC(time, timeMs, lat, lon) };
      take({ kind: 'stage', lat, lon, utcOffsetSec, firstDayMs: localDayStart(timeMs, utcOffsetSec), day: 1, timeMs, wetness: sky.wetness, snapshots: [], fixed });
      // Only the clock's display needs the real time zone.
      const mine = state;
      fetchUtcOffsetSec(lat, lon).then((offset) => {
        if (state === mine) state.utcOffsetSec = offset;
      });
    },

    /** Saved state (snapshot()) back. */
    restore(saved) {
      if (!Number.isFinite(saved?.timeMs)) return false;
      take({ snapshots: [], fixed: null, ...saved });
      return true;
    },

    /** For the save (and to go back to with restore()). */
    snapshot() {
      return state && { ...state };
    },

    /** Per physics step: the clock at real speed. */
    tick(dtSec) {
      if (!state) return;
      state.timeMs += dtSec * 1000;
      if (state.timeMs - appliedAt >= APPLY_INTERVAL_MS) apply();
    },

    /** A time jump (service, field fix, skipped liaison...). */
    advance(ms) {
      if (!state || !(ms > 0)) return;
      state.timeMs += ms;
      apply();
    },

    /** Parc fermé: the night passes, the next day starts at `startMin` (local). Returns the new day's number. */
    endDay(startMin) {
      if (!state) return 1;
      let next = state.firstDayMs + state.day * MS_PER_DAY + startMin * 60_000;
      // A day that ran past the next one's start rolls on to the day after.
      while (next <= state.timeMs) next += MS_PER_DAY;
      state.day = Math.round((localDayStart(next, state.utcOffsetSec) - state.firstDayMs) / MS_PER_DAY) + 1;
      state.timeMs = next;
      apply();
      return state.day;
    },

    /**
     * Rally forecast snapshots from day 1 to day `days` (or today, if later), each with its rally `day`
     * and `state`: 'done' (passed), 'current' (the one in force now) or ''. Empty in fixed weather or offline.
     */
    forecast(days) {
      if (!state?.snapshots?.length) return [];
      const lastDay = Math.max(days, state.day);
      const rows = state.snapshots
        .map((s) => ({ ...s, day: Math.floor((s.ms - state.firstDayMs) / MS_PER_DAY) + 1, state: '' }))
        .filter((s) => s.day >= 1 && s.day <= lastDay);
      const now = rows.findLastIndex((s) => s.ms <= state.timeMs);
      rows.forEach((s, i) => (s.state = i < now ? 'done' : i === now ? 'current' : ''));
      return rows;
    },

    getDay: () => state?.day ?? 1,
    isRunning: () => !!state,
    /**
     * An epoch whose time in the browser's zone reads the rally's local time at `ms` (default now),
     * for Date's local getters and toLocaleTimeString.
     */
    displayMs(ms = state?.timeMs ?? Date.now()) {
      if (!state) return ms;
      return ms + state.utcOffsetSec * 1000 + new Date(ms).getTimezoneOffset() * 60_000;
    },
  };
}
