// Shared by the main thread and tileWorker.js (so the worker never pulls in three.js).

// Free, keyless aerial imagery.
export const AERIAL_URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

// AWS Terrarium elevation tiles. Must use the virtual-hosted-style bucket
// URL: the path-style one returns no CORS headers.
export const ELEVATION_URL = (z, x, y) =>
  `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;

export const AERIAL_TILE_SIZE = 256;
