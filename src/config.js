// App-wide configuration and shared tuning constants.

// ---------- App mode ----------
// "dev" (vite dev): debug visuals on, no networking.
// "prod" (build): shared MQTT room, debug visuals off.
// Override with ?mode=dev / ?mode=prod.
const FORCED_MODE = new URLSearchParams(location.search).get('mode');
export const APP_MODE = FORCED_MODE === 'dev' || FORCED_MODE === 'prod' ? FORCED_MODE : (import.meta.env.DEV ? 'dev' : 'prod');
export const IS_DEV_MODE = APP_MODE === 'dev';
// Address-search teleport; local to this player, never broadcast.
export const CAN_CHANGE_LOCATION = true;
export const CAN_USE_NETWORK = !IS_DEV_MODE;

// Spawn point (Wroclaw) and fixed network origin: all poses are exchanged
// in local metres relative to it, whatever each player teleports to.
export const ORIGIN_LAT = 51.1079;
export const ORIGIN_LON = 17.0385;

// Body colour when the lobby is skipped (dev mode).
export const DEFAULT_BODY_COLOR = 0xffffff;

// ---------- Controls ----------
export const STEER_SPEED = 0.01
export const MAX_STEER = 0.5;
// Flat per-wheel handbrake force, independent of vehicle power.
export const BRAKE_FORCE = 3000;
export const TURBO_MULT = 4;
// Hold to charge, release to jump; full charge = max speed.
export const JUMP_CHARGE_S = 1.2;
export const JUMP_MIN_SPEED = 5;
export const JUMP_MAX_SPEED = 15;
// Airborne A/D adds yaw directly, capped.
export const AIR_YAW_ACCEL = 2.4;
export const AIR_YAW_MAX = 1.5;

// ---------- Collision response (arcade impact roll) ----------
export const IMPACT_ROLL_MIN_SPEED = 2.5; // m/s along the normal; slower contacts ignored
export const IMPACT_ROLL_TORQUE_SCALE = 0.22; // spin per m/s of impact

// ---------- Ground-tunneling guard ----------
export const GROUND_RAY_HEIGHT = 50;
export const MIN_GROUND_CLEARANCE = 0.05;

// ---------- Building-tunneling guard ----------
export const BUILDING_SWEEP_MIN_DIST_M = 0.15; // skip the sweep for smaller per-step moves
export const BUILDING_SWEEP_BACKOFF_M = 0.1; // pull-back distance after a caught tunnel

// ---------- Building-embed guard ----------
export const BUILDING_EMBED_RAY_HEIGHT = 500;
export const BUILDING_EMBED_EPSILON_M = 0.2; // tolerance so parking on a roof isn't "embedded"

// ---------- Score ----------
export const SCORE_PER_KM = 1;
export const SCORE_TELEPORT_M = 20; // larger per-frame jumps are resets, not driving
// Airtime: all wheels off and chassis this high above terrain (ride
// height ~1.25 m, full droop ~2 m).
export const SCORE_PER_AIR_SECOND = 10;
export const FLIGHT_MIN_CLEARANCE_M = 2.4;
// Min dot(chassis up, world up) for airtime to count (0.5 ~ 60deg tilt).
export const AIRTIME_MIN_UPRIGHT_DOT = 0.5;
export const AIRTIME_MIN_DURATION_S = 0.5; // shorter hops don't pay
export const SCORE_PER_PEDESTRIAN = 5;
export const SCORE_PER_CAR_HIT = 3; // shooter only

// ---------- Camera follow ----------
// Shared defaults; each view in app/cameraViews/ may override any of them.
export const CAMERA_OFFSET = [0, 20, -30];
export const CAMERA_LOOKAT_OFFSET = [0, 5, 10];
export const CAMERA_POSITION_SPEED = 3; // lower = smoother
export const CAMERA_LOOKAT_SPEED = 50;
// Yaw is smoothed separately: suspension noise in the raw yaw is amplified
// by the long offset into jitter.
export const CAMERA_YAW_SPEED = 6;
// Below this dot(carUp, worldUp) the car counts as flipped; yaw is frozen.
export const FLIP_UP_DOT_THRESHOLD = 0.5;
// Below this speed (m/s) aim along the chassis heading, not velocity.
export const CAMERA_MIN_SPEED_FOR_VELOCITY_YAW = 1;
// Offset scales with speed: SCALE_AT_MIN at/below MIN_SPEED .. SCALE_AT_MAX
// at/above MAX_SPEED (m/s).
export const CAMERA_CLOSE_MIN_SPEED = 10;
export const CAMERA_CLOSE_MAX_SPEED = 100;
export const CAMERA_CLOSE_SCALE_AT_MIN_SPEED = 0.6;
export const CAMERA_CLOSE_SCALE_AT_MAX_SPEED = 1;
// Leads the smoothing target by velocity * settling time to cancel the
// steady-state lag at high speed (1 = full, 0 = none).
export const CAMERA_POSITION_LEAD_FACTOR = 0.7;
// Cosmetic pitch following sustained climbs/falls (velocity angle).
export const CAMERA_PITCH_SPEED = 5;
export const CAMERA_PITCH_MAX_ANGLE = (30 * Math.PI) / 180;
export const CAMERA_PITCH_MIN_SPEED = 2; // m/s; below, the camera levels out

// ---------- Gauges HUD ----------
export const MAX_GAUGE_SPEED = 180; // km/h at full needle deflection

// ---------- Terrain stats HUD ----------
// Columns = tile x (east, left->right), rows = tile y (south, top->bottom),
// so (dx, dy) steps match the on-screen grid.
export const DIRECTIONS = [
  { dx: 0, dy: -1, arrow: '↑' }, // N (up)
  { dx: 1, dy: -1, arrow: '↗' }, // NE
  { dx: 1, dy: 0, arrow: '→' }, // E (right)
  { dx: 1, dy: 1, arrow: '↘' }, // SE
  { dx: 0, dy: 1, arrow: '↓' }, // S (down)
  { dx: -1, dy: 1, arrow: '↙' }, // SW
  { dx: -1, dy: 0, arrow: '←' }, // W (left)
  { dx: -1, dy: -1, arrow: '↖' }, // NW
];
export const STATS_UPDATE_INTERVAL = 0.25; // seconds

// ---------- Networking / lobby ----------
export const NET_STATUS_TEXT = {
  connecting: 'Connecting…',
  online: 'In the room',
  offline: 'Offline — driving solo',
};

// ---------- Players panel HUD ----------
export const PLAYERS_UPDATE_INTERVAL = 1; // seconds
// "Active" if a pose arrived within this window (poses stream ~10/s).
export const PLAYERS_ACTIVE_THRESHOLD_MS = 60_000;


// ---------- Main loop ----------
export const FIXED_STEP = 1 / 60;
export const MAX_SUBSTEPS = 5;

// ---------- Minimap HUD ----------
export const MINIMAP_MIN_ZOOM = 3; // continent
export const MINIMAP_MAX_ZOOM = 19; // buildings
export const MINIMAP_DEFAULT_ZOOM = 17;
// Documents the #minimap CSS size; not read by code (keep in sync).
export const MINIMAP_SIZE_PX = 260;

// ---------- localStorage keys ----------
export const MINIMAP_STORAGE_KEY = 'driver.minimapZoom';
export const LOBBY_STORAGE_KEY = 'driver.lobby.v1';
export const CAR_STATE_STORAGE_KEY = 'driver.carState.v1';
export const DEV_CAR_STORAGE_KEY = 'driver.devCar.v1'; // dev-mode debug picker
export const PLAYER_ID_STORAGE_KEY = 'driver.playerId.v1'; // stable network identity
export const CAMERA_VIEW_STORAGE_KEY = 'driver.cameraView.v1';
