// Game modes listed in the main menu; each keeps its own save slot (lib/saves.js).
// `starts`: kinds of game in place of the single "Start new"/"Continue", each with its own save slot
// (`available: false` greys one out). The menu labels them "New <name>" and, for `saves` starts,
// "Resume <name>"; other starts keep nothing but `keepOnNewGame` fields and start over after a reload.
// `keepOnNewGame`: save fields a new game keeps (e.g. the last picked car, the last stage / rally file opened).
// `cameraView`: camera view until the player picks one (C), else the global default.
// `fireAndJump`: F shoots and J jumps (keyboard only); off unless set.
// `teleport: false`: no teleport from the Navigation tab (editors still have it).
// `directionSignHud: false`: no top-centre copy of direction signs (also off in every editor).
// `editor`: the mode gets an Editor button; `editorAvailable` enables it (needs a format in lib/scenarios/formats.js).

export const GAME_MODES = [
  {
    id: 'freeRoam',
    label: 'Free Roam',
    blurb: 'Drive anywhere on real-world roads.',
    available: true,
    fireAndJump: true,
  },
  {
    id: 'rally',
    label: 'Rally',
    blurb: 'Flat out against the clock on real-world roads. Run a single stage, a full rally, or a whole career.',
    available: true,
    starts: [
      { id: 'stage', name: 'Single stage' },
      { id: 'rally', name: 'Single rally', saves: true },
      { id: 'career', name: 'Career', saves: true, available: false },
    ],
    keepOnNewGame: ['vehicle', 'lastFile'],
    cameraView: 'close',
    teleport: false,
    directionSignHud: false,
    editor: true,
    editorAvailable: true,
  },
  {
    id: 'honestWork',
    label: 'Honest Work',
    blurb: 'Get jobs done with heavy-duty machines: trucks, cranes, diggers and more. Take on tasks and manage your own business.',
    available: false,
    starts: [
      { id: 'job', name: 'Single job' },
      { id: 'business', name: 'Business', saves: true },
    ],
    editor: true,
  },
  {
    id: 'pathsOfHate',
    label: 'Paths of Hate',
    blurb: 'Missions across a scorched, lawless wasteland, where fuel is worth more than life. Armour up and survive the roads.',
    available: false,
    starts: [
      { id: 'mission', name: 'Single mission' },
      { id: 'campaign', name: 'Campaign', saves: true },
    ],
    editor: true,
  },
  {
    id: 'chariotsOfFire',
    label: 'Chariots of Fire',
    blurb: 'Race jet-powered chariots at insane speeds. Hold the line or end up in pieces.',
    available: false,
    starts: [
      { id: 'race', name: 'Single race' },
      { id: 'championship', name: 'Championship', saves: true },
      { id: 'career', name: 'Career', saves: true },
    ],
    editor: true,
  },
];

export const DEFAULT_GAME_MODE_ID = 'freeRoam';

export const getGameMode = (id) => GAME_MODES.find((m) => m.id === id) ?? null;

export const getStart = (mode, startId) => mode?.starts?.find((s) => s.id === startId) ?? null;

/** Whether a game of this mode + start saves its progress (car position, results); modes without starts always do. */
export const keepsProgress = (mode, startId) => !mode?.starts || !!getStart(mode, startId)?.saves;
