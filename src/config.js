// Central app configuration: run mode, spawn origin, and tuning constants
// shared across modules. Keeping these here (rather than scattered through
// main.js) lets other files (input, camera, HUD, physics...) import just
// the constants they need without depending on the composition root.

// ---------- App mode ----------
// Two run modes, driven by Vite's built-in DEV flag (true for `npm run dev`,
// false for `npm run build`/the deployed GitHub Pages build - see
// vite.config.js), so no extra env setup is needed to get the right mode:
//  - "dev": local development. Debug visuals (tile HUD, hitbox wireframes)
//    default on. Networking (the shared MQTT room) is a prod-only feature -
//    dev mode never opens that connection, so you always drive
//    solo/offline against localhost without depending on (or spamming) the
//    public broker.
//  - "prod": the shared remote build. Debug visuals default off.
// Can still be forced either way (e.g. to test the prod build's behavior
// from `vite dev`) via ?mode=prod / ?mode=dev in the URL.
const FORCED_MODE = new URLSearchParams(location.search).get('mode');
export const APP_MODE = FORCED_MODE === 'dev' || FORCED_MODE === 'prod' ? FORCED_MODE : (import.meta.env.DEV ? 'dev' : 'prod');
export const IS_DEV_MODE = APP_MODE === 'dev';
// Whether the player is allowed to change their real-world location (via
// the address search bar). Always on: teleporting only ever recenters the
// requesting player's own terrain/buildings/car and is never broadcast to
// anyone else, so it can't disturb the shared world's starting point or
// any other player's session (see ui/addressSearch.js).
export const CAN_CHANGE_LOCATION = true;
// Whether to connect to the shared MQTT room at all (see net.js). Off in
// dev so local development never touches the public broker.
export const CAN_USE_NETWORK = !IS_DEV_MODE;

// Real-world spawn location (Wroclaw city center). The terrain streams in
// real aerial imagery + elevation around wherever the car currently is, so
// you can drive anywhere on Earth from here - it's just the starting point.
// Also doubles as the fixed "network origin": every player's pose is
// published/interpreted in local meters relative to this exact point, for
// everyone, forever, regardless of where any individual player personally
// teleports their own view to (see ui/addressSearch.js + geo.js's
// remapLocalOrigin) - that's what keeps a personal teleport from moving
// the shared starting point or corrupting multiplayer position sync.
export const ORIGIN_LAT = 51.1079;
export const ORIGIN_LON = 17.0385;

// Starting body color when the lobby is skipped (dev mode). The lobby
// itself uses a color picker; this is only the fallback blue.
export const DEFAULT_BODY_COLOR = 0x1c3f94;

// ---------- Controls ----------
export const MAX_FORCE = 300;
export const MAX_STEER = 0.5;
// Brakes should be able to stop the car at least as decisively as the engine
// can accelerate it, so scale brake force off the engine's max power instead
// of using an unrelated fixed constant.
export const BRAKE_FORCE = MAX_FORCE * 10;
export const TURBO_MULT = 4;
// Jump charges while the button is held and fires on release. A tap is a
// small hop; holding out the full charge time reaches the high jump.
export const JUMP_CHARGE_S = 1.2;
export const JUMP_MIN_SPEED = 5;
export const JUMP_MAX_SPEED = 15;
// Air steering. Wheels do nothing once they're off the ground, so A/D add
// yaw directly. Capped so a held turn is a heading change, not a blender.
export const AIR_YAW_ACCEL = 2.4;
export const AIR_YAW_MAX = 1.5;

// ---------- Collision response (arcade impact roll) ----------
// Ignore near-stationary grazes/resting contacts (e.g. gently rolling up
// against a wall) - only impacts above this relative speed (m/s along the
// contact normal) trigger the arcade flip/roll response.
export const IMPACT_ROLL_MIN_SPEED = 2.5;
// Tuning knob for how dramatic a qualifying hit's induced spin is; scales
// linearly with impact speed, so a glancing tap barely rocks the car while
// a hard head-on/corner hit can flip it.
export const IMPACT_ROLL_TORQUE_SCALE = 0.22;

// ---------- Ground-tunneling guard ----------
export const GROUND_RAY_HEIGHT = 50;
export const MIN_GROUND_CLEARANCE = 0.05;

// ---------- Building-tunneling guard ----------
// Below this squared distance moved in a single physics step, don't bother
// sweeping - normal driving speeds never cover enough ground in 1/60s to
// tunnel through a building anyway, so this is just cutting out a
// raycastClosest call on almost every step.
export const BUILDING_SWEEP_MIN_DIST_M = 0.15;
// How far back along the step's own movement to land the chassis once a
// tunneling hit is caught - just enough clearance that next step's normal
// contact resolution can take over instead of immediately re-tunneling.
export const BUILDING_SWEEP_BACKOFF_M = 0.1;

// ---------- Building-embed guard ----------
// How far above/below the chassis to cast the "is this spot under a
// building's roof?" ray - tall enough to clear any real building plus the
// chassis' own resting height on either side.
export const BUILDING_EMBED_RAY_HEIGHT = 500;
// Tolerance (metres) before a chassis sitting right at/just above a roof
// (i.e. legitimately parked on top of a building) is mistaken for one
// embedded just below it.
export const BUILDING_EMBED_EPSILON_M = 0.2;

// ---------- Score ----------
// One point per whole kilometre of horizontal travel. A frame that jumps
// farther than this is a reset or a map recenter, not driving.
export const SCORE_PER_KM = 1;
export const SCORE_TELEPORT_M = 20;
// Ten points per whole second the car is actually flying: every wheel off
// the ground, and the chassis center at least this far above the terrain.
// Resting ride height is about 1.25 m; fully extended suspension just
// clears the surface around 2 m, so 2.4 m is a real gap rather than a
// crest, a curb, or the car sitting on its roof.
export const SCORE_PER_AIR_SECOND = 10;
export const FLIGHT_MIN_CLEARANCE_M = 2.4;
// How upright the chassis must be, mid-air, for airtime to keep counting:
// the dot product of the chassis' local up axis (world-transformed) against
// world up. 1 is dead level, 0 is on its side, -1 is upside down. 0.5 (~60°
// of pitch/roll either way) still allows a stunt jump's natural rotation
// while excluding an actual barrel-roll/flip from paying out.
export const AIRTIME_MIN_UPRIGHT_DOT = 0.5;
// A jump must be airborne at least this long before it pays out at all -
// filters out curbs, bumps, and other trivial hops that briefly lift a
// wheel but aren't a real jump.
export const AIRTIME_MIN_DURATION_S = 0.5;
export const SCORE_PER_PEDESTRIAN = 5;
// A few points for a shot that connects with another player's car. Less
// than running someone over, and only the shooter scores.
export const SCORE_PER_CAR_HIT = 3;

// ---------- Camera follow ----------
export const CAMERA_OFFSET = [0, 30, -20];
export const CAMERA_LOOKAT_OFFSET = [0, 10.5, 10];
// Lower = smoother/slower camera pan, so crashes don't whip the camera around.
export const CAMERA_POSITION_SPEED = 2.5;
export const CAMERA_LOOKAT_SPEED = 3;
// Raw yaw (from the chassis quaternion) carries small high-frequency noise
// from suspension/wheel-contact vibration, which gets amplified a lot by
// the long camera offset (~36 units) into visible high-speed jitter. Smooth
// the yaw angle itself (not just the final position) to filter that noise
// out while still turning briskly with real heading changes.
export const CAMERA_YAW_SPEED = 6;
// Below this dot(carUp, worldUp) the car is considered "flipped" (on its
// roof/side, tumbling mid-crash, etc.) - roughly more than ~60 degrees of
// tilt. Projecting the forward vector to get a yaw becomes unstable/
// meaningless once the car is that far from upright (it can spin the
// camera rapidly during a barrel roll), so we just freeze the last good
// yaw and hold the camera steady until the car is upright again.
export const FLIP_UP_DOT_THRESHOLD = 0.5;
// Below this horizontal speed (m/s) the velocity direction is too noisy/
// undefined (e.g. standing still, or barely rolling) to aim the camera at,
// so we fall back to the chassis heading instead.
export const CAMERA_MIN_SPEED_FOR_VELOCITY_YAW = 1;

// ---------- Gauges HUD ----------
export const MAX_GAUGE_SPEED = 180; // km/h at full needle deflection

// ---------- Terrain stats HUD ----------
// 8-direction lookup, ordered to match on-screen layout: grid columns are
// tile-x (world +x/east, left->right) and grid rows are tile-y (world
// +z/south, top->bottom) - see geo.js. So a direction's (dx, dy) here maps
// 1:1 onto how many cells to step right/down in the rendered grid, and the
// arrow glyphs point the same way on screen as the car is actually heading.
export const DIRECTIONS = [
  { dx: 0, dy: -1, arrow: '\u2191' }, // N (up)
  { dx: 1, dy: -1, arrow: '\u2197' }, // NE
  { dx: 1, dy: 0, arrow: '\u2192' }, // E (right)
  { dx: 1, dy: 1, arrow: '\u2198' }, // SE
  { dx: 0, dy: 1, arrow: '\u2193' }, // S (down)
  { dx: -1, dy: 1, arrow: '\u2199' }, // SW
  { dx: -1, dy: 0, arrow: '\u2190' }, // W (left)
  { dx: -1, dy: -1, arrow: '\u2196' }, // NW
];
export const STATS_UPDATE_INTERVAL = 0.25; // seconds; DOM updates don't need to happen every frame

// ---------- Networking / lobby ----------
export const NET_STATUS_TEXT = {
  connecting: 'Connecting…',
  online: 'In the room',
  offline: 'Offline — driving solo',
};

// ---------- Players panel HUD ----------
// DOM updates don't need to happen every frame - a peer's roster idle
// state only changes on the order of seconds.
export const PLAYERS_UPDATE_INTERVAL = 1; // seconds
// Below this time since a peer's last pose update, they're shown as
// "Active" (poses stream every ~100ms while a tab is open/connected, so in
// practice this only flips to idle once someone's tab is backgrounded,
// their connection hiccups, or they're about to drop out of the roster
// entirely - see net.js ROSTER_TTL_MS).
export const PLAYERS_ACTIVE_THRESHOLD_MS = 60_000;


// ---------- Main loop ----------
export const FIXED_STEP = 1 / 60;
export const MAX_SUBSTEPS = 5;

// ---------- Minimap HUD ----------
// Slippy-map tile zoom levels (same convention as the terrain streamer).
// 3 is whole-continent scale; 19 is close to individual-building scale.
export const MINIMAP_MIN_ZOOM = 3;
export const MINIMAP_MAX_ZOOM = 19;
export const MINIMAP_DEFAULT_ZOOM = 17;
// Diameter of the round minimap widget, in CSS pixels. Documents the
// actual size set on #minimap in index.html (the widget reads its real
// size off the DOM each frame, so this constant isn't consumed directly -
// keep it in sync if you resize the CSS).
export const MINIMAP_SIZE_PX = 260;
export const MINIMAP_STORAGE_KEY = 'driver.minimapZoom';
// Persists the lobby name/color choice across reloads (see src/ui/lobby.js).
export const LOBBY_STORAGE_KEY = 'driver.lobby.v1';
// Persists the local car's last known position/orientation/odometer across
// reloads (see src/lib/carState.js).
export const CAR_STATE_STORAGE_KEY = 'driver.carState.v1';
// Persists a stable, invisible-to-the-player network identity across
// reloads (see src/lib/playerId.js), so this browser keeps the same
// "clientId" instead of minting a new one every page load - otherwise
// every reload would look like a brand-new peer to everyone else (ghost
// duplicates in the remote-cars list and "who's online" roster).
export const PLAYER_ID_STORAGE_KEY = 'driver.playerId.v1';
