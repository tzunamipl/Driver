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
