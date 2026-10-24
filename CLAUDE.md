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
    `rivers.js`; `vectorPolygonLayer.js` → `waterAreas.js`, `builtUpAreas.js` (OSM landuse → built-up zone, `isBuiltUpAt`). `roadside.js` = knockable objects (trigger + tumbling debris in `knockable.js`, also used by the rally control scenery) placed from the streets layer's segments, one kind per file: `roadPosts.js` (edge posts), `streetLamps.js` (replace posts in built-up areas; night lighting in `streetLights.js`), `roadSigns.js` (chevron boards on curves/hairpins), `directionSigns.js` (arrow boards at junctions, rules in `config.js`, destinations from `places.js`; per-item meshes, HUD copy in `hud/directionSignHud.js`). `tiles/openFreeMap.js` = vector tile
    fetch. `geo.js` = lat/lon ↔ tile ↔ local metres.
  - Vehicles: `car.js` = entry (`createCar`/`createRemoteCar`) + wheeled rig, helpers in `car/`
    (chassis body/inertia/hitboxes, wheel mesh, remote car, `axles.js` = descriptor `axles` layout
    + shared-turn-centre steering for any axle count/duals, `trailer.js` = articulated trailer hitch;
    trailer wheels live in the same `wheelInfos`). Hover vehicles go to `chariot.js`,
    helpers in `chariot/` (hover repulsor, formation heading/coupling/tether, remote).
    `vehicleShared.js` = shared bits (material, name tag, reset helpers, remote shell).
    `wheeledVehicle.js` (custom raycast vehicle), `engine.js` (engine + gearbox, auto or fully manual
    with neutral; optional turbo from descriptor `turbo` - boost lag scales torque, gauge in `hud/boostGauge.js`; `gearGate.js` = H-gate + parallel range layout for the manual stick, `hud/gearstick.js` draws it), `fuel.js` (tank per descriptor `fuelTankL`/`fuelType`, burns by `engine.throttle`, `loadFraction` + rpm, adds fuel mass to the chassis), `engineHeat.js` (block/coolant/oil temps from load, rpm and airflow; thermostat + fan; descriptor `radiator`/`coolantL`; coolant level with leaks from nose hits (`collisions.js` `frontImpactSpeed`) and boil-over, limp-mode `powerFactor` into `engine.js`; fixed by reset and `repairs: true` rally points; outside air = `AMBIENT_TEMP_C` placeholder), `airDrag.js`,
    `surfaceCompounds.js` (also per-surface tyre wear / puncture / wet / dirt factors), `terrainSurface.js`. `tyres.js` = tread wear
    (grip), rim-strike punctures and running on the rim (smaller radius, drag, toe pull, no sidewall), per-wheel
    fields used by `wheeledVehicle.js`; reset and rally service points (`tyres: true` point types) fit fresh tyres.
    `tyres/compounds.js` = tyre types (grip per surface, wear, temp window, wet/dirt traits; descriptor `tyreCompound` = stock),
    `tyres/condition.js` = tread temperature, dirt, wetness (`WEATHER_WETNESS` placeholder in `config.js`),
    `tyres/setup.js` = player setup { compound, rimSize, width, profile } around stock (descriptor `tyreSizes`), applied
    to the descriptor by `createCar`. `garage.js` = per-mode, per-vehicle paint + tyre setup (mode-wide save field);
    picked in `ui/tyreSetupPicker.js` (lobby, rally picker, debug picker, rally `ui/tyreServiceDialog.js`).
  - `vehicles/` – one descriptor file per vehicle (tuning data) + `geometry/` (mesh builders).
    Register new vehicles in `vehicles/index.js`.
  - Effects: `tireSmoke.js`, `terrainDust.js`, `bodyDust.js`, `exhaustFlames.js`
    (backfire pops scaled by descriptor `backfire` 0..1, tips from `exhaustTips`, plus a flash point light) (all on
    `particles/puffPool.js`), `rimSparks.js` (tyre-pop smoke + spark burst, sparks from flat rims on road/rock; streaks
    from `particles/sparkles.js`, shared with the rally controls), `splash.js`, `clouds.js` - visual only; sound events go out via callbacks.
    `headlights.js` = cosmetic lamps + front and rear ground spotlights (brake/reverse on the rear; on/off in `app/headlightSwitch.js`); geometry builders tag lamp
    materials with `userData: { lamp: 'head' | 'tail' | 'fog' }`.
  - Audio: `audio/audioContext.js` = the one shared `AudioContext` (unlock on first gesture,
    `music`/`sfx`/`engine` buses, shared noise buffer); one file per sound in `audio/`
    (`engine.js` voices from `descriptor.engineSound`, `horn.js`, `music.js`, `tireSqueal.js`, `gravelSpin.js`, `bodyScrape.js`,
    `waterWade.js`, `impact.js`, `postHit.js`, `tyrePop.js`, `rimGrind.js`, `gearShift.js`, `backfire.js`, `sparklePop.js`, `startBeep.js`). Never create another `AudioContext`.
  - Gameplay/net: `net.js` (MQTT room), `remoteCollisions.js`, `pedestrians.js`, `ball.js`,
    `shots.js`, `jump.js`, `carState.js` / `playerId.js` / `vehicleOdometers.js` (per-car km) (localStorage). `cloudSave.js` backs up save slots, profile and odometers through the worker (newer copy wins at launch).
- Scenarios (data in the separate public repo `SCENARIOS_REPO`, format in its README; sources are `owner/repo@branch`):
  `lib/scenarios/` = `source.js` (fetch by commit), `paths.js` (files at `<mode>/<country>/<region>/<kind>/<id>.json`; the `country/region/id` key is what index + refs use), `publish.js` (editor save via the worker to the player-name branch + PR), one format
  per mode registered in `formats.js` (`rally.js`), `roadSnap.js` + `gateMarkers.js`. A mode's Editor button starts an
  editor session (own save slot): `app/scenarioEditor.js` (logic, per-frame markers) + `ui/editorPanel.js`.
- Online leaderboards + editor saves: `worker/` = Cloudflare Worker (own `package.json`, `wrangler.toml`, deployed by `.github/workflows/worker.yml`) that validates stage times
  against the official stage file and keeps each player's best in the GitHub data repo, and commits editor saves to a player-name branch of the
  scenarios repo with a PR; the tokens are worker secrets, never in the bundle. Client: `lib/leaderboard.js`, URL from `VITE_LEADERBOARD_URL` (`.env.local` locally, repo variable in CI).
- Rally mode: `app/rally/rallySession.js` (pick via `ui/rallyPicker.js` + plan map `ui/rallyPlanMap.js`, itinerary, spawn, progress save, blocks
  teleport/navigation via their `setBlocked` while a stage is live) + `stageRun.js` (per-physics-step timing state
  machine); `hud/rallyPlanHud.js` = itinerary side panel, plan icons go to the minimap / Navigation map via `setScenarioPoints`; `lib/rally/` = FIA boards, arches, split flags, fireworks (`controlScenery.js`), per-point-type props (`zoneProps.js`); `hud/rallyHud.js`;
  R rocks the car (`app/carRocking.js`) instead of resetting it. Pacenotes: stage files carry optional `pacenotes` (format +
  wording in `lib/rally/pacenoteCalls.js`), generated in the editor by `lib/rally/pacenotes.js` (corners/junctions) over
  `lib/rally/stageRoute.js` (own OSM tile fetch + road graph + route through the gates); in play `app/rally/pacenoteRun.js`
  tracks the next note, `hud/pacenoteHud.js` draws the strip.
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
