# Driver POC

Setup:
```
npm install
```

You need a free Mapbox access token for real-world elevation data (aerial
imagery uses the free, keyless Esri World Imagery tiles, so no token is
needed for that part). Create one at https://mapbox.com (no credit card
required for the free tier), then put it in a `.env.local` file (gitignored):
```
VITE_MAPBOX_TOKEN=pk.your_token_here
```

Run:
```
npm run dev
```
Open the printed URL (e.g. http://localhost:5173).

Controls: W/↑ throttle, S/↓ brake-reverse, A/D or ←/→ steer, Space handbrake, R reset car.

## Real-world terrain

The car spawns in Wrocław, Poland by default (`ORIGIN_LAT`/`ORIGIN_LON` in
`src/main.js`), but the map is not limited to that location: `TerrainManager`
(`src/lib/terrain.js`) streams a grid of real aerial-imagery + elevation
chunks around the car as it drives, loading new chunks ahead and unloading
ones left behind — so you can in principle drive anywhere on Earth, starting
from wherever you set as the origin.

Each chunk is a displaced-plane Three.js mesh (Esri satellite photo + Mapbox
Terrain-RGB elevation) with a matching Cannon-es physics collider built from
the exact same vertices, so what you see always matches what you drive on.

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
