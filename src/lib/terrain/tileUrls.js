// Shared by the main thread and tileWorker.js (so the worker never pulls in three.js).

// Free, keyless aerial imagery. Both hosts serve identical tiles over HTTP/1.1,
// so alternating them doubles the browser's 6-connections-per-host limit.
// blankTile=false: a missing tile is a 404, not a "Map data not yet available" placeholder.
const AERIAL_HOSTS = ['server.arcgisonline.com', 'services.arcgisonline.com'];
export const AERIAL_URL = (z, x, y) =>
  `https://${AERIAL_HOSTS[(x + y) & 1]}/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}?blankTile=false`;
// Which aerial tiles exist in a size x size window: { data: [0|1] row-major, location: { left, top, width, height } }.
export const AERIAL_TILEMAP_URL = (z, x, y, size) =>
  `https://${AERIAL_HOSTS[(x + y) & 1]}/ArcGIS/rest/services/World_Imagery/MapServer/tilemap/${z}/${y}/${x}/${size}/${size}`;
// The imagery is upsampled past this around here: deeper tiles cost requests, not detail.
export const AERIAL_MAX_ZOOM = 21;
// Concurrent aerial requests the browser will actually run (6 per host).
export const AERIAL_MAX_REQUESTS = 6 * AERIAL_HOSTS.length;

// AWS Terrarium elevation tiles. Must use the virtual-hosted-style bucket
// URL: the path-style one returns no CORS headers.
export const ELEVATION_URL = (z, x, y) =>
  `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;

export const AERIAL_TILE_SIZE = 256;
