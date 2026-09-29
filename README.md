# Driver POC

Setup:
```
npm install
```

No API keys or accounts needed — both data sources are free and keyless:
aerial imagery from Esri World Imagery, and elevation from AWS Terrarium
tiles (Mapzen's open elevation dataset, mirrored as a public S3 bucket).

Elevation fetch failures (network hiccups, a tile genuinely missing, etc.)
don't remove terrain from view: `TerrainManager` falls back to a flat (y=0)
patch for any chunk whose elevation tile fails to load, for both the detail
and far tiers, and the origin elevation lookup in `init()` falls back to a
zero height baseline rather than blocking app startup. So terrain (flat
where data was unavailable) always renders; check the browser console for
`elevation fetch failed` warnings to see which specific tiles fell back.

Run:
```
npm run dev
```
Open the printed URL (e.g. http://localhost:5173).

Controls: W/↑ throttle, S/↓ brake-reverse, A/D or ←/→ steer, Space handbrake, R reset car.

## Real-world terrain

The car spawns in Wrocław, Poland by default (`ORIGIN_LAT`/`ORIGIN_LON` in
`src/main.js`), but the map is not limited to that location: `TerrainManager`
(`src/lib/terrain.js`) streams real aerial-imagery + elevation chunks around
the car as it drives, loading new chunks ahead and unloading ones left
behind — so you can in principle drive anywhere on Earth, starting from
wherever you set as the origin.

Chunks are streamed in a **circle** around the car (not a square) — for each
tile offset `(dx, dy)` from the player's current tile, it's only loaded if
`dx² + dy² <= radius²` (with a little slack so the circle isn't overly
sparse). This avoids wastefully loading/rendering the far corners of a
square footprint that are actually farther from the player than tiles
already excluded on the circle's flat sides.

Terrain streams at **two levels of detail**:

- **Detail tier** (`DETAIL_ZOOM = 15`, ~2 tile radius around the player):
  full-resolution aerial photo texture (stitched from higher-zoom Esri
  tiles) + a 32×32 displaced-plane mesh, each with a matching Cannon-es
  Trimesh physics collider built from the exact same vertices, so what you
  see always matches what you drive on.
- **Far tier** (`FAR_ZOOM = 9`, out to `FAR_RADIUS_METERS = 150_000`, i.e.
  150km): a much coarser 12×12 mesh built from elevation data only — no
  aerial imagery fetch (it would be blurry at this scale and multiplies
  request count) and no physics body (the player is always within the
  detail tier's footprint, so far chunks are never actually driven on).
  Colored with a simple elevation → color ramp (green lowland → brown
  hills → grey rock → white snow cap) standing in for real imagery, purely
  so the horizon isn't blank past the detailed area.

Both tiers load/unload independently, each on its own tile grid, driven from
the same `TerrainManager.update()` call every frame. Both stage removals a
few ticks before actually unloading a chunk (`UNLOAD_DELAY_TICKS` /
`FAR_UNLOAD_DELAY_TICKS`) to avoid load/unload thrashing right at the radius
boundary.

Rendering the far tier requires the camera/scene to actually reach that far:
`camera.far` is set well past `FAR_RADIUS_METERS` (otherwise the far mesh is
silently frustum-culled), the renderer uses a logarithmic depth buffer
(needed once the view spans ~0.1m up to tens of km, or depth precision
z-fights at distance), and `scene.fog` is an exponential (`FogExp2`) falloff
rather than a hard linear cutoff, so it stays subtle near the car but still
naturally fades the far tier into the sky color at longer range instead of
hard-clipping it out of view.

The debug terrain-stats HUD (toggle with the debug-visuals control) reports
detail- and far-tier loaded/loading/removing counts and estimated memory
separately; the on-screen tile map only visualizes the detail tier, since
the far tier's footprint (100+ tiles) is too large to usefully render as a
grid.

## Debug visuals (press M to toggle)

Pressing `M` toggles a set of debug-only overlays together: the terrain
tile-stats HUD (top-right), the 3D tile perimeter borders, and a
**suspension HUD** (bottom-left) showing each wheel's live spring travel as
a vertical bar - 0% at full droop (fully extended), 100% at full compression
(bottomed out), with a fixed marker line at 50% for the spring's rest
length. Bars turn yellow then red as a wheel approaches its compression
limit, and grey out (showing "air") when the wheel has left the ground.
Values are read directly off each wheel's Cannon-es `WheelInfo`
(`suspensionLength` / `suspensionRestLength` / `maxSuspensionTravel` /
`isInContact`) in `updateSuspensionHud()` in `src/main.js`.

## Physics notes / gotchas

**cannon-es does not implement Box (or any ConvexPolyhedron) vs. Trimesh
collision.** Its narrowphase (`node_modules/cannon-es/dist/cannon-es.js`,
`Narrowphase` class) only has a real `sphereTrimesh` handler; the
`convexTrimesh` getter is present but commented out. Since the ground in this
project is a `CANNON.Trimesh` (built from real elevation data in
`terrain.js`), any chassis body using a plain `CANNON.Box` shape will **never
generate a collision with the ground** — it silently falls straight through
narrowphase, with zero warning/error. It only *looked* like it worked before
because the `RaycastVehicle` wheels use raycasts (which do work against
Trimesh) to hold the car up during normal driving; a crash/rollover that lifts
the chassis off its wheels (or flips it) would fall through the world.

Fix used in `src/lib/car.js`: the chassis body's shape is a **compound of 8
`CANNON.Sphere`s, one at each box corner**, inset by exactly their radius so
they sit flush with (not protruding past) the visible box mesh. Spheres do
collide with Trimesh, so this "simplified hitbox" lets the chassis physically
hit the ground and tumble/roll correctly on crashes, while still closely
matching the visual box. If you ever need a tighter-fitting hitbox, add more
spheres (e.g. a mid-row along the long axis) rather than switching back to a
single Box shape.

This was confirmed empirically (not just by reading the source) with a
standalone script: dropping a `CANNON.Box` chassis onto a `CANNON.Trimesh`
ground body falls through indefinitely (position keeps decreasing, no
collision response ever fires), while the same test with 8 corner spheres
settles correctly at rest.

Two other things worth knowing when touching this code:
- `world.defaultContactMaterial.friction` is intentionally low (`0.05`); the
  `RaycastVehicle` wheels do their own tire-friction simulation
  (`frictionSlip` on each wheel), so this setting mainly affects how much the
  chassis itself slides/rolls on direct body-body contact (e.g. after a
  crash), not normal driving grip.
- `main.js`'s `preventGroundTunneling()` raycasts straight down and clamps the
  chassis above the terrain every frame. This was originally added to guard
  against *fast-rotation tunneling* (a real, separate concern even with
  working shape collision), but before the sphere-hitbox fix it was also
  incidentally the *only* thing prevented the car from falling through the
  world at all. Keep it — it's still useful as a tunneling safety net on top
  of the sphere hitbox.
