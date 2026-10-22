# Driver

Browser driving game on real-world terrain. Vanilla JS (ES modules), three.js (render),
cannon-es (physics), MQTT (multiplayer), Vite. No tests, no TS, no framework.

- `npm run dev` – local dev server; `npm run build` – sanity check (catches import/syntax errors).
- Deployed to GitHub Pages via `.github/workflows/pages.yml`.

## Layout
- `src/main.js` – composition root: creates every subsystem and wires them together.
- `src/config.js` – run mode, spawn origin, global tuning constants.
- `src/app/` – game orchestration: `mainLoop.js` (per-frame update order), `carManager.js`
  (local car spawn/respawn + remote roster), `input.js`, `collisions.js` (arcade responses,
  tunnel guards), `cameraFollow.js` + `cameraViews/` (one file per camera), `scoring.js`,
  `sceneSetup.js`, `physicsSetup.js`. `frameBudget.js` = one shared per-frame streaming budget
  (`STREAMING_BUDGET_MS`) spent by tier: terrain is off-budget (must-have), then GAMEPLAY (near
  building collisions), then COSMETIC (rotated); streamers take a `deadline`. `gameplayLoad.js` =
  what startup/teleport await after terrain (overlay data + near buildings). `viewFrame.js` = this player's local frame (network frame is
  fixed at `ORIGIN`); `floatingOrigin.js` shifts the world back to near (0,0) every 2 km - anything
  keeping world-space positions between frames needs a `shiftOrigin(dx, dz)` registered there.
- `src/lib/` – subsystems:
  - World streaming: `terrain.js` (quadtree of elevation + aerial tiles, `TerrainManager`; worker
    fetch/decode + mesh building in `terrain/`; detail tiles carve OSM roads in as a raised bed, `terrain/roadBed.js`, with Heightfield physics), `buildings.js`
    (+ `buildingsCache.js` IndexedDB). Debug/gameplay overlays extend `tiles/vectorTileLayer.js`
    (fetch, bucketing, time-sliced builds, unload): `vectorLineLayer.js` → `streets.js`,
    `rivers.js`; `vectorPolygonLayer.js` → `waterAreas.js`, `builtUpAreas.js` (OSM landuse → built-up zone, `isBuiltUpAt`). `roadside.js` = knockable objects placed from the streets layer's segments, one kind per file: `roadPosts.js` (edge posts), `streetLamps.js` (replace posts in built-up areas; night lighting in `streetLights.js`), `roadSigns.js` (chevron boards on curves/hairpins), `directionSigns.js` (arrow boards at junctions, rules in `config.js`, destinations from `places.js`; per-item meshes, HUD copy in `hud/directionSignHud.js`). `tiles/openFreeMap.js` = vector tile
    fetch. `geo.js` = lat/lon ↔ tile ↔ local metres.
  - Vehicles: `car.js` = entry (`createCar`/`createRemoteCar`) + wheeled rig, helpers in `car/`
    (chassis body/inertia/hitboxes, wheel mesh, remote car, `axles.js` = descriptor `axles` layout
    + shared-turn-centre steering for any axle count/duals, `trailer.js` = articulated trailer hitch;
    trailer wheels live in the same `wheelInfos`). Hover vehicles go to `chariot.js`,
    helpers in `chariot/` (hover repulsor, formation heading/coupling/tether, remote).
    `vehicleShared.js` = shared bits (material, name tag, reset helpers, remote shell).
    `wheeledVehicle.js` (custom raycast vehicle), `engine.js` (engine + gearbox, auto or fully manual
    with neutral; `gearGate.js` = H-gate + parallel range layout for the manual stick, `hud/gearstick.js` draws it), `airDrag.js`,
    `surfaceCompounds.js`, `terrainSurface.js`.
  - `vehicles/` – one descriptor file per vehicle (tuning data) + `geometry/` (mesh builders).
    Register new vehicles in `vehicles/index.js`.
  - Effects: `tireSmoke.js`, `terrainDust.js`, `bodyDust.js` (all on
    `particles/puffPool.js`), `splash.js`, `clouds.js` - visual only; sound events go out via callbacks.
    `headlights.js` = cosmetic lamps (on/off in `app/headlightSwitch.js`); geometry builders tag lamp
    materials with `userData: { lamp: 'head' | 'tail' | 'fog' }`.
  - Audio: `audio/audioContext.js` = the one shared `AudioContext` (unlock on first gesture,
    `music`/`sfx`/`engine` buses, shared noise buffer); one file per sound in `audio/`
    (`engine.js` voices from `descriptor.engineSound`, `horn.js`, `music.js`, `tireSqueal.js`, `gravelSpin.js`, `bodyScrape.js`,
    `waterWade.js`, `impact.js`, `postHit.js`, `gearShift.js`, `sparklePop.js`, `startBeep.js`). Never create another `AudioContext`.
  - Gameplay/net: `net.js` (MQTT room), `remoteCollisions.js`, `pedestrians.js`, `ball.js`,
    `shots.js`, `jump.js`, `carState.js` / `playerId.js` (localStorage).
- Scenarios (data in the separate public repo `SCENARIOS_REPO`, format in its README; sources are `owner/repo@branch`):
  `lib/scenarios/` = `source.js` (fetch by commit), `paths.js` (files at `<mode>/<country>/<region>/<kind>/<id>.json`; the `country/region/id` key is what index + refs use), `github.js` (token commit to the player's fork/branch), one format
  per mode registered in `formats.js` (`rally.js`), `roadSnap.js` + `gateMarkers.js`. A mode's Editor button starts an
  editor session (own save slot): `app/scenarioEditor.js` (logic, per-frame markers) + `ui/editorPanel.js`.
- Rally mode: `app/rally/rallySession.js` (pick via `ui/rallyPicker.js` + plan map `ui/rallyPlanMap.js`, itinerary, spawn, progress save, blocks
  teleport/navigation via their `setBlocked` while a stage is live) + `stageRun.js` (per-physics-step timing state
  machine); `hud/rallyPlanHud.js` = itinerary side panel, plan icons go to the minimap / Navigation map via `setScenarioPoints`; `lib/rally/` = FIA boards, arches, split flags, fireworks (`controlScenery.js`), per-point-type props (`zoneProps.js`); `hud/rallyHud.js`;
  R rocks the car (`app/carRocking.js`) instead of resetting it.
- Game modes: `app/gameModes.js` lists them; `ui/mainMenu.js` (Continue / Game mode / Settings, Esc mid-game)
  picks one before `main.js` builds the world (top-level await; dev mode skips it), switching mid-game reloads.
  `lib/saves.js` = one save slot per mode, or per mode + start (e.g. `rally.career`; car state, vehicle, nav destination, menu status) - per-mode
  state goes through `readSaveField`/`writeSaveField`. `ui/lobby.js` = profile (name + default vehicle), asked once.
- `src/hud/` – DOM HUD widgets (minimap, gauges, debug HUDs). `src/ui/` – lobby, pickers, `navigationPanel.js` (Navigation tab: search + slippy map, OSM tiles via `hud/mapTiles.js`) on top of `addressSearch.js` (geocoding + teleport); Navigate = road route from OSRM (`lib/routing.js`), progress in `app/routeGuidance.js`, drawn by `hud/routeLine.js` on the minimap and the tab's map.
- `index.html` – DOM skeleton for HUD/UI. Styles: `src/styles/*.css` (one per UI area, imported
  in cascade order by `src/styles/index.css`).

## Conventions
- Modules export `createX(...)` factories returning plain objects, or `XManager` classes for
  tile streamers (`update`, `recenter`, `getStats`, `isTileLoaded`).
- Physics axes: x right, y up, z forward. Collision groups exported from `terrain.js` / `buildings.js`.
- Per-vehicle values come from the descriptor with a module-level default (`descriptor.x ?? DEFAULT_X`).
- Keep comments short: one line of *why* for non-obvious choices; no history or cross-file narration.
- Before implementing, ask clarifying questions whenever a request is ambiguous or has
  several reasonable interpretations (behaviour, layout, tuning values, which vehicles).
  Don't guess on design decisions the user should make.

## Token hints
- `README.md` is user-facing docs with deep background; usually skip it.
- Largest files: `terrain.js` (~1000 lines), `buildings.js`, `vehicles/geometry/levorg.js` –
  grep for the function first and read only that range.
- Comment-only edits can be verified by building and comparing the hash of `dist/assets/*.js`
  (the minifier strips comments; mask the `YY.MM.DD-HH.MM` build timestamp first).
