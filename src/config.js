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

// Day-night cycle speed: 1 = real time. Faster cycles wrap within today's
// real date, so the sun's seasonal path always matches the actual date.
export const TIME_SCALE = 24;
// Sun / moon disc colour by the body's own elevation above the horizon (deg),
// blended linearly between keys and held past the ends. Keys sorted by `el`.
export const SUN_DISC_COLORS = [
  { el: -2, color: 0xff6a30 },
  { el: 2, color: 0xff8a40 },
  { el: 8, color: 0xffd070 },
  { el: 20, color: 0xfff2a0 },
  { el: 40, color: 0xfffbe0 },
];
export const MOON_DISC_COLORS = [
  { el: -2, color: 0xffa060 },
  { el: 4, color: 0xf0d0a0 },
  { el: 15, color: 0xc4cce0 },
  { el: 30, color: 0xaebce0 },
];

// Body colour when the lobby is skipped (dev mode).
export const DEFAULT_BODY_COLOR = 0xffffff;

// ---------- Controls ----------
export const STEER_SPEED = 0.01
export const MAX_STEER = 0.5;
// Flat per-wheel handbrake force, independent of vehicle power.
export const BRAKE_FORCE = 3000;
// Pedal brake starts capped at this share of the tyres' static grip (just short of locking)...
export const BRAKE_GRIP_START = 0.8;
// ...the cap rises to the grip limit over this hold time, then lifts so the wheels can lock.
export const BRAKE_LOCK_S = 0.4;
// Holding the handbrake this long leaves it pulled until the next press.
export const HANDBRAKE_LATCH_S = 1.7;
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

// ---------- Building colliders ----------
export const BUILDING_PHYSICS_DISTANCE_M = 300; // buildings within this of the car get a collider

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
// Camera drops back while gaining speed and moves in while braking: metres per m/s² of
// (filtered) forward acceleration, easing towards LAG_MAX back / LEAD_MAX in (kept small so
// it can't reach the car); RATE (1/s) filters it and sets how fast it settles once speed evens out. 0 = off.
export const CAMERA_ACCEL_LAG = 0;
export const CAMERA_ACCEL_LAG_MAX = 6;
export const CAMERA_ACCEL_LEAD_MAX = 2.5;
export const CAMERA_ACCEL_LAG_RATE = 1.5;
// Cosmetic pitch following sustained climbs/falls (velocity angle).
export const CAMERA_PITCH_SPEED = 5;
export const CAMERA_PITCH_MAX_ANGLE = (30 * Math.PI) / 180;
export const CAMERA_PITCH_MIN_SPEED = 2; // m/s; below, the camera levels out
export const CAMERA_GROUND_CLEARANCE_M = 0.5; // every view stays this far above the terrain
// Teleport transition: wide orbit round the car while the destination loads.
export const TELEPORT_CAMERA_FOV_DEG = 115;
export const TELEPORT_CAMERA_ORBIT_RATE = 9.5; // rad/s, top spin speed
export const TELEPORT_CAMERA_SPIN_UP_S = 3.5; // time from still to top spin
export const TELEPORT_CAMERA_SPIN_DOWN_S = 1.2; // top spin to still once loaded, overlaps the blend out
export const TELEPORT_CAMERA_ROLL_DEG = 12; // dutch tilt at top spin, eases with the spin speed
// The jump itself (car placed at the destination): FOV snaps narrower, then wobbles back.
export const TELEPORT_CAMERA_JUMP_FOV_DEG = 40; // FOV drop at the jump
export const TELEPORT_CAMERA_JUMP_WOBBLE_S = 1.5;
export const TELEPORT_CAMERA_JUMP_WOBBLE_HZ = 2.5;
export const TELEPORT_CAMERA_ORBIT_RADIUS = 14; // m, times descriptor.cameraScale
export const TELEPORT_CAMERA_ORBIT_HEIGHT = 6; // m above the car, times descriptor.cameraScale
export const TELEPORT_CAMERA_BLEND_IN_S = 0.8;
export const TELEPORT_CAMERA_BLEND_OUT_S = 2;
export const TELEPORT_CAMERA_MIN_S = 2.5; // orbit at least this long, even on a fast load
export const TELEPORT_CAMERA_SETTLE_S = 1; // after the car is placed: lets it drop onto its wheels

// ---------- Road edge posts ----------
export const ROAD_POST_SPACING_M = 25; // along the road, each side
export const ROAD_POST_HAIRPIN_DENSITY = 10; // spacing divisor between a hairpin's chevron boards
export const STREET_LAMP_SPACING_M = 40; // built-up areas, replacing the posts; between consecutive lamps, sides alternating
// Guard rails replace the posts on an edge where the ground this far out is this much below the road.
export const GUARD_RAIL_DROP_M = 2;
export const GUARD_RAIL_DROP_DISTANCE_M = 8; // past the road bed's flat top (stripe edge + a grid cell)
export const ROADSIDE_DRAW_DISTANCE_M = 200; // posts and curve signs, from the car

// ---------- Forests (landcoverAreas.js, trees.js, terrain/forestFloor.js) ----------
export const TREE_DRAW_DISTANCE_M = 800; // from the car
export const TREE_TRUNK_DISTANCE_M = 300; // past this only crowns are drawn
export const TREE_PHYSICS_DISTANCE_M = 150; // trunks within this of the car get a collider
// Tree kind: pines start mixing in at PINE_MIX_START_ASL_M and are the only kind from
// PINE_ONLY_ASL_M (both at PINE_REFERENCE_LAT); both drop PINE_ASL_PER_DEG_M per degree poleward.
export const PINE_MIX_START_ASL_M = 500;
export const PINE_ONLY_ASL_M = 1300;
export const PINE_REFERENCE_LAT = 50;
export const PINE_ASL_PER_DEG_M = 80;
// Forest trees shrink linearly from TREE_SHRINK_START_ASL_M to TREE_SHRINK_END_ASL_M (same latitude
// drop as the pine line), where the biggest are TREE_MIN_TOP_M tall; width shrinks TREE_SHRINK_WIDTH_SHARE as much.
export const TREE_SHRINK_START_ASL_M = 500;
export const TREE_SHRINK_END_ASL_M = 2000;
export const TREE_MIN_TOP_M = 3;
export const TREE_SHRINK_WIDTH_SHARE = 0.5;
export const TREE_GROW_M = 400; // grow-in: zero size at the draw distance, full size this much closer
export const TREE_AREA_PER_TREE_M2 = 300; // density: one tree per this much forest (jittered grid)
export const TREE_GAP_M = 8; // trees keep this clear of every street line's and water's edge; floor noise starts at twice it from roads
// Scrub bushes (trees.js createBushes): same placement as trees, sparser and nearer.
export const BUSH_DRAW_DISTANCE_M = 400; // from the car
export const BUSH_GROW_M = 150; // grow-in, as TREE_GROW_M
export const BUSH_AREA_PER_BUSH_M2 = 1200; // density: one bush per this much scrub (jittered grid)
export const BUSH_GAP_M = 4; // bushes keep this clear of every street line's and water's edge
// Rocks (trees.js createRocks) on rock/scree landcover: bush density, solid near the car.
export const ROCK_DRAW_DISTANCE_M = 400; // from the car
export const ROCK_GROW_M = 150; // grow-in, as TREE_GROW_M
export const ROCK_AREA_PER_ROCK_M2 = 1200; // density: one rock per this much rock area (jittered grid)
export const ROCK_GAP_M = 4; // rocks keep this clear of every street line's and water's edge
export const ROCK_PHYSICS_DISTANCE_M = 120; // rocks within this of the car get a collider
export const FOREST_FLOOR_NOISE_M = 2; // peak terrain offset (+/-) on the forest floor; 0 = off

// ---------- Direction signs (directionSigns.js) ----------
// Junctions that get signs: higher road class -> lower classes it's signed with.
// A branch on the junction's higher-class road points to a city, one on the lower to the nearest village/town.
export const DIRECTION_SIGN_JUNCTIONS = {
  trunk: ['trunk', 'primary', 'secondary', 'tertiary', 'minor'],
  primary: ['primary', 'secondary', 'tertiary', 'minor'],
  secondary: ['secondary', 'tertiary', 'minor'],
  tertiary: ['tertiary', 'minor'],
  minor: ['minor'],
};
// Junctions of one class only: these classes point to cities, the rest to villages/towns.
export const DIRECTION_SIGN_CITY_CLASSES_WHEN_EQUAL = ['trunk', 'primary'];

// ---------- Weather ----------
export const AMBIENT_TEMP_C = 15; // outside air (°C); placeholder until weather drives it
export const WEATHER_WETNESS = 0; // 0 dry .. 1 soaked surfaces (tyre wet grip); placeholder until rain drives it

// ---------- Gauges HUD ----------
export const MAX_GAUGE_SPEED = 180; // km/h speedo scale for rigs without an engine (wheeled cars use their gearing top speed)

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
  solo: 'Singleplayer',
};

// ---------- Players panel HUD ----------
export const PLAYERS_UPDATE_INTERVAL = 1; // seconds
// "Active" if a pose arrived within this window (poses stream ~10/s).
export const PLAYERS_ACTIVE_THRESHOLD_MS = 60_000;


// ---------- Rendering ----------
// Reversed float depth instead of logarithmic (cheaper per pixel); falls back to log depth without EXT_clip_control.
export const REVERSED_DEPTH = true;

// ---------- Main loop ----------
export const FIXED_STEP = 1 / 60;
export const MAX_SUBSTEPS = 5;
// Main-thread streaming work per frame (mesh builds, object placement), shared by every
// streamer in priority order (app/frameBudget.js). Terrain tile installs aren't on it.
export const STREAMING_BUDGET_MS = 6;

// ---------- Graphics detail (Settings) ----------
// Foliage: drawDistance in m, areaPerItem = m² of landcover per tree / bush / rock (density).
export const GRAPHICS_DETAIL_LEVELS = {
  low: {
    label: 'Low',
    terrainCells: 15,
    streamingBudgetMs: 3,
    roadsideDrawDistance: 100,
    trees: { drawDistance: 350, areaPerItem: 800 },
    bushes: { drawDistance: 150, areaPerItem: 3000 },
    rocks: { drawDistance: 150, areaPerItem: 3000 },
  },
  medium: {
    label: 'Medium',
    terrainCells: 40,
    streamingBudgetMs: 4.5,
    roadsideDrawDistance: 150,
    trees: { drawDistance: 550, areaPerItem: 450 },
    bushes: { drawDistance: 250, areaPerItem: 1800 },
    rocks: { drawDistance: 250, areaPerItem: 1800 },
  },
  high: {
    label: 'High',
    terrainCells: 80,
    streamingBudgetMs: STREAMING_BUDGET_MS,
    roadsideDrawDistance: ROADSIDE_DRAW_DISTANCE_M,
    trees: { drawDistance: TREE_DRAW_DISTANCE_M, areaPerItem: TREE_AREA_PER_TREE_M2 },
    bushes: { drawDistance: BUSH_DRAW_DISTANCE_M, areaPerItem: BUSH_AREA_PER_BUSH_M2 },
    rocks: { drawDistance: ROCK_DRAW_DISTANCE_M, areaPerItem: ROCK_AREA_PER_ROCK_M2 },
  },
};
export const DEFAULT_GRAPHICS_DETAIL = 'high';

// ---------- Minimap HUD ----------
export const MINIMAP_MIN_ZOOM = 3; // continent
export const MINIMAP_MAX_ZOOM = 19; // buildings
export const MINIMAP_DEFAULT_ZOOM = 17;
// Documents the #minimap CSS size; not read by code (keep in sync).
export const MINIMAP_SIZE_PX = 260;

// ---------- localStorage keys ----------
export const MINIMAP_STORAGE_KEY = 'driver.minimapZoom';
export const LOBBY_STORAGE_KEY = 'driver.lobby.v1';
export const MULTIPLAYER_STORAGE_KEY = 'driver.multiplayer.v1';
export const CAR_STATE_STORAGE_KEY = 'driver.carState.v1'; // legacy, migrated into SAVES_STORAGE_KEY
export const SAVES_STORAGE_KEY = 'driver.saves.v1'; // per-game-mode save slots (lib/saves.js)
export const LAUNCH_STORAGE_KEY = 'driver.launch'; // sessionStorage: mode to start after a menu reload
export const VEHICLE_COLORS_STORAGE_KEY = 'driver.vehicleColors.v1'; // per-vehicle paint
export const DEFAULT_PAINT_STORAGE_KEY = 'driver.defaultPaint.v1'; // '1' = every car in its default paint
export const VEHICLE_ODOMETERS_STORAGE_KEY = 'driver.vehicleOdometers.v1'; // per-vehicle km, shared by all modes
export const DEV_CAR_STORAGE_KEY = 'driver.devCar.v1'; // dev-mode debug picker
export const PLAYER_ID_STORAGE_KEY = 'driver.playerId.v1'; // stable network identity
export const GRAPHICS_DETAIL_STORAGE_KEY = 'driver.graphicsDetail';
export const CAMERA_VIEW_STORAGE_KEY = 'driver.cameraView.v1'; // legacy
export const DEBUG_LAYERS_STORAGE_KEY = 'driver.debugLayers.v1';
export const DEBUG_VISUALS_STORAGE_KEY = 'driver.debugVisuals.v1'; // K-key debug view on/off
export const TIME_PRESET_STORAGE_KEY = 'driver.timePreset.v1';
export const GEAR_MODE_STORAGE_KEY = 'driver.gearMode.v1'; // sport/comfort/eco gearbox
export const TRANSMISSION_STORAGE_KEY = 'driver.transmission.v1'; // auto/manual gearbox
export const NAV_DESTINATION_STORAGE_KEY = 'driver.navDestination.v1'; // legacy Navigation tab pin
export const LEGACY_GITHUB_TOKEN_STORAGE_KEY = 'driver.githubToken.v1'; // old editor saves; wiped on start
export const RALLY_HANDBRAKE_HOLD_STORAGE_KEY = 'driver.rallyHandbrakeHold.v1'; // Settings > Gameplay > Rally
export const EDITOR_SOURCE_STORAGE_KEY = 'driver.editorSource.v1'; // scenario source the editor opens from
export const EDITOR_PACENOTE_BOARDS_STORAGE_KEY = 'driver.editorPacenoteBoards.v1'; // '0' = editor hides pacenote boards

// ---------- Scenarios ----------
// Official scenarios: this repo's main branch. Custom ones: any fork/branch, as `owner/repo@branch`.
export const SCENARIOS_REPO = { owner: 'tzunamipl', repo: 'Driver-scenarios' };
export const OFFICIAL_SCENARIO_SOURCE = `${SCENARIOS_REPO.owner}/${SCENARIOS_REPO.repo}@main`;
export const SCENARIO_FORMAT = 3; // files with a newer format are rejected; 3 = rally point references
export const EDITOR_SNAP_RADIUS_M = 40; // placed gates snap to a road centreline within this
export const LEADERBOARD_URL = import.meta.env.VITE_LEADERBOARD_URL ?? ''; // worker/; unset = no online times or editor saves
export const RALLY_BEST_STORAGE_KEY = 'driver.rallyBest.v1'; // best stage times: { 'source|stageId': { totalMs, splits } }

// ---------- Cloud save ----------
// Backup of save slots, profile and odometers through the worker (lib/cloudSave.js), keyed by the player id.
export const CLOUD_SAVE_STORAGE_KEY = 'driver.cloudSave.v1'; // { hash, updatedAt, pushedAt } of the backed-up data
export const CLOUD_SAVE_INTERVAL_MS = 2 * 60_000; // each push is a data-repo commit
export const CLOUD_SAVE_MIN_GAP_MS = 30_000; // menu opens push sooner, but not more often than this
export const CLOUD_SAVE_RESTORE_TIMEOUT_MS = 3000; // launch waits this long for the backup, then plays on local data
