// A stage's road line for pacenotes: OSM roads from the vector tiles along the stage (fetched
// here, not the streamed streets layer, which only covers the car's surroundings) as a graph,
// and the shortest route through its waypoints. Lines are clipped to their own tile so ends
// meet at tile borders; vertices closer than MERGE_M are one node.

import { fetchVectorTileLayer } from '../tiles/openFreeMap.js';
import { classifyRoad, ROAD_HIERARCHY } from '../roadClasses.js';
import { lon2tileX, lat2tileY, tileX2lon, tileY2lat, latLonToLocal } from '../geo.js';

const TILE_ZOOM = 14; // the transportation layer's maxzoom
const CORRIDOR_TILES = 1; // tiles fetched either side of the straight line between waypoints
const CORRIDOR_STEP_M = 200;
const FETCH_CONCURRENCY = 6;
const MERGE_M = 1;
const DANGLE_JOIN_M = 3; // a line ending this close to another's vertex joins it
const SNAP_M = 60; // waypoint to the nearest road
const SKIP_CLASSES = new Set(['path']); // not driven (as lib/scenarios/roadSnap.js)
const DEFAULT_RANK = ROAD_HIERARCHY.indexOf('minor');

const tileCache = new Map(); // `${tx},${ty}` -> Promise<layer | null>

function fetchTile(tx, ty) {
  const key = `${tx},${ty}`;
  let promise = tileCache.get(key);
  if (!promise) {
    promise = fetchVectorTileLayer(TILE_ZOOM, tx, ty, 'transportation');
    promise.catch(() => tileCache.delete(key));
    tileCache.set(key, promise);
  }
  return promise;
}

/** Tiles touched by the straight lines between consecutive waypoints, widened by CORRIDOR_TILES. */
function corridorTiles(waypoints) {
  const keys = new Set();
  const add = (lat, lon) => {
    const tx = Math.floor(lon2tileX(lon, TILE_ZOOM));
    const ty = Math.floor(lat2tileY(lat, TILE_ZOOM));
    for (let dx = -CORRIDOR_TILES; dx <= CORRIDOR_TILES; dx++) {
      for (let dy = -CORRIDOR_TILES; dy <= CORRIDOR_TILES; dy++) keys.add(`${tx + dx},${ty + dy}`);
    }
  };
  waypoints.forEach((p, i) => {
    add(p.lat, p.lon);
    const q = waypoints[i + 1];
    if (!q) return;
    const { x, z } = latLonToLocal(q.lat, q.lon, p.lat, p.lon);
    const steps = Math.ceil(Math.hypot(x, z) / CORRIDOR_STEP_M);
    for (let k = 1; k < steps; k++) add(p.lat + ((q.lat - p.lat) * k) / steps, p.lon + ((q.lon - p.lon) * k) / steps);
  });
  return [...keys].map((key) => key.split(',').map(Number));
}

/** Liang-Barsky clip of a->b to [0, max]^2: { a, b, t0, t1 } or null. */
function clipSegment(a, b, max) {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x], [dx, max - a.x], [-dy, a.y], [dy, max - a.y]]) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
  }
  if (t0 > t1) return null;
  return { a: { x: a.x + dx * t0, y: a.y + dy * t0 }, b: { x: a.x + dx * t1, y: a.y + dy * t1 }, t0, t1 };
}

/** Runs of a tile-space line inside the tile proper (the buffer around it is the neighbours' part). */
function clipLine(line, max) {
  const runs = [];
  let run = null;
  for (let i = 0; i + 1 < line.length; i++) {
    const c = clipSegment(line[i], line[i + 1], max);
    if (!c) {
      run = null;
      continue;
    }
    if (!run || c.t0 > 0) {
      run = [c.a];
      runs.push(run);
    }
    run.push(c.b);
    if (c.t1 < 1) run = null;
  }
  return runs.filter((r) => r.length >= 2);
}

function createGraph() {
  const nodes = [];
  const cells = new Map();
  const cellKey = (cx, cz) => `${cx},${cz}`;

  function nodeAt(x, z) {
    const cx = Math.floor(x / MERGE_M);
    const cz = Math.floor(z / MERGE_M);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const node of cells.get(cellKey(cx + i, cz + j)) ?? []) {
          if (Math.hypot(node.x - x, node.z - z) < MERGE_M) return node;
        }
      }
    }
    const node = { x, z, links: [] };
    nodes.push(node);
    const key = cellKey(cx, cz);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(node);
    return node;
  }

  /** `road`: { width, rank, unpaved } (or a link to copy them from). */
  function link(a, b, { width, rank, unpaved }) {
    if (a === b || a.links.some((l) => l.node === b)) return;
    a.links.push({ node: b, width, rank, unpaved });
    b.links.push({ node: a, width, rank, unpaved });
  }

  function unlink(a, b) {
    a.links = a.links.filter((l) => l.node !== b);
    b.links = b.links.filter((l) => l.node !== a);
  }

  return { nodes, nodeAt, link, unlink };
}

function addTile(graph, layer, tx, ty, origin) {
  const { extent } = layer;
  for (let f = 0; f < layer.length; f++) {
    const feature = layer.feature(f);
    if (feature.type !== 2) continue; // LineString
    const style = classifyRoad(feature.properties);
    if (!style || SKIP_CLASSES.has(style.key)) continue;
    const rank = ROAD_HIERARCHY.indexOf(style.key);
    const road = { width: style.width, rank: rank >= 0 ? rank : DEFAULT_RANK, unpaved: !!style.unpaved };
    for (const run of feature.loadGeometry().flatMap((line) => clipLine(line, extent))) {
      let prev = null;
      for (const p of run) {
        const lat = tileY2lat(ty + p.y / extent, TILE_ZOOM);
        const lon = tileX2lon(tx + p.x / extent, TILE_ZOOM);
        const { x, z } = latLonToLocal(lat, lon, origin.lat, origin.lon);
        const node = graph.nodeAt(x, z);
        if (prev) graph.link(prev, node, road);
        prev = node;
      }
    }
  }
}

/** Joins line ends that stop just short of another road (mapping gaps, simplified vertices). */
function joinDangles(graph) {
  const cells = new Map();
  const key = (x, z) => `${Math.floor(x / DANGLE_JOIN_M)},${Math.floor(z / DANGLE_JOIN_M)}`;
  for (const node of graph.nodes) {
    const k = key(node.x, node.z);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(node);
  }
  for (const node of graph.nodes) {
    if (node.links.length !== 1) continue;
    const cx = Math.floor(node.x / DANGLE_JOIN_M);
    const cz = Math.floor(node.z / DANGLE_JOIN_M);
    let best = null;
    let bestDist = DANGLE_JOIN_M;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const other of cells.get(`${cx + i},${cz + j}`) ?? []) {
          if (other === node || other === node.links[0].node) continue;
          const d = Math.hypot(other.x - node.x, other.z - node.z);
          if (d < bestDist) {
            bestDist = d;
            best = other;
          }
        }
      }
    }
    if (best) graph.link(node, best, node.links[0]);
  }
}

/** A node on the nearest road to local (x, z), splitting its segment there; null if none within SNAP_M. */
function snapNode(graph, x, z) {
  let best = null;
  let bestDist = SNAP_M;
  for (const a of graph.nodes) {
    for (const l of a.links) {
      const b = l.node;
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const lenSq = abx * abx + abz * abz;
      if (lenSq < 1e-9) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / lenSq));
      const d = Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t));
      if (d < bestDist) {
        bestDist = d;
        best = { a, b, t, road: l };
      }
    }
  }
  if (!best) return null;
  const { a, b, t, road } = best;
  if (t * Math.hypot(b.x - a.x, b.z - a.z) < MERGE_M) return a;
  if ((1 - t) * Math.hypot(b.x - a.x, b.z - a.z) < MERGE_M) return b;
  const node = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, links: [] };
  graph.nodes.push(node);
  graph.unlink(a, b);
  graph.link(a, node, road);
  graph.link(node, b, road);
  return node;
}

/** A* by length; node list from `from` to `to`, or null. */
function shortestPath(from, to) {
  const g = new Map([[from, 0]]);
  const cameFrom = new Map();
  const h = (n) => Math.hypot(n.x - to.x, n.z - to.z);
  const heap = [[h(from), from]];
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent][0] <= heap[i][0]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const closed = new Set();
  while (heap.length) {
    const [, node] = pop();
    if (node === to) {
      const path = [to];
      while (path[0] !== from) path.unshift(cameFrom.get(path[0]));
      return path;
    }
    if (closed.has(node)) continue;
    closed.add(node);
    const base = g.get(node);
    for (const { node: next } of node.links) {
      const cost = base + Math.hypot(next.x - node.x, next.z - node.z);
      if (cost < (g.get(next) ?? Infinity)) {
        g.set(next, cost);
        cameFrom.set(next, node);
        push([cost + h(next), next]);
      }
    }
  }
  return null;
}

/**
 * Road route through `waypoints` ({lat, lon, label?}, in driving order) on OSM roads.
 * @returns {Promise<{origin: {lat: number, lon: number}, nodes: object[]}>} nodes in local
 *   metres around `origin` (x east, z south), each with `links` to its neighbours ({ node, width, rank, unpaved }).
 */
export async function routeStage(waypoints, { onProgress } = {}) {
  const origin = { lat: waypoints[0].lat, lon: waypoints[0].lon };
  const tiles = corridorTiles(waypoints);
  const graph = createGraph();
  let done = 0;
  const queue = [...tiles];
  async function worker() {
    while (queue.length) {
      const [tx, ty] = queue.shift();
      const layer = await fetchTile(tx, ty);
      if (layer) addTile(graph, layer, tx, ty, origin);
      onProgress?.(++done, tiles.length);
    }
  }
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  joinDangles(graph);

  const stops = waypoints.map((p, i) => {
    const { x, z } = latLonToLocal(p.lat, p.lon, origin.lat, origin.lon);
    const node = snapNode(graph, x, z);
    if (!node) throw new Error(`No road within ${SNAP_M} m of ${p.label ?? `point ${i + 1}`}`);
    return node;
  });
  const nodes = [stops[0]];
  for (let i = 1; i < stops.length; i++) {
    const leg = shortestPath(stops[i - 1], stops[i]);
    if (!leg) throw new Error(`No road route from ${waypoints[i - 1].label ?? `point ${i}`} to ${waypoints[i].label ?? `point ${i + 1}`}`);
    for (const node of leg.slice(1)) {
      // Turning back over the road just driven (a waypoint just off the line): drop the spur.
      if (nodes.length >= 2 && nodes[nodes.length - 2] === node) nodes.pop();
      else nodes.push(node);
    }
  }
  return { origin, nodes };
}
