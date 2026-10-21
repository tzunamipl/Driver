// Game modes listed in the main menu; each keeps its own save slot (lib/saves.js).
// `starts`: new-game buttons in place of the single "Start new" (`available: false` greys one out);
// the picked start's id is saved as the slot's `start`. `continueLabel` renames Continue.
// `keepOnNewGame`: save fields a new game keeps (e.g. the last picked car).
// `progressStarts`: starts whose progress (car position, results) is saved; default all. Others start over after a reload.
// `directionSignHud: false`: no top-centre copy of direction signs (also off in every editor).
// `editor`: the mode gets an Editor button; `editorAvailable` enables it (needs a format in lib/scenarios/formats.js).

export const GAME_MODES = [
  {
    id: 'freeRoam',
    label: 'Free Roam',
    blurb: 'Drive anywhere on real-world roads.',
    available: true,
  },
  {
    id: 'rally',
    label: 'Rally',
    blurb: 'Flat out against the clock on real-world roads. Run a single stage, a full rally, or a whole career.',
    available: true,
    starts: [
      { id: 'stage', label: 'Single stage' },
      { id: 'rally', label: 'Rally' },
      { id: 'career', label: 'New career', available: false },
    ],
    continueLabel: 'Continue',
    keepOnNewGame: ['vehicle'],
    progressStarts: ['career'],
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
      { id: 'job', label: 'Single job' },
      { id: 'business', label: 'New business' },
    ],
    continueLabel: 'Continue business',
    editor: true,
  },
  {
    id: 'pathsOfHate',
    label: 'Paths of Hate',
    blurb: 'Missions across a scorched, lawless wasteland, where fuel is worth more than life. Armour up and survive the roads.',
    available: false,
    starts: [
      { id: 'mission', label: 'Single mission' },
      { id: 'campaign', label: 'New campaign' },
    ],
    continueLabel: 'Continue campaign',
    editor: true,
  },
  {
    id: 'chariotsOfFire',
    label: 'Chariots of Fire',
    blurb: 'Race jet-powered chariots at insane speeds. Hold the line or end up in pieces.',
    available: false,
    starts: [
      { id: 'race', label: 'Single race' },
      { id: 'championship', label: 'Championship' },
      { id: 'career', label: 'New career' },
    ],
    continueLabel: 'Continue career',
    editor: true,
  },
];

export const DEFAULT_GAME_MODE_ID = 'freeRoam';

export const getGameMode = (id) => GAME_MODES.find((m) => m.id === id) ?? null;
