// One-off: the board files of the old GitHub data repo (rally/**/*.json) as D1 inserts.
//   node worker/scripts/boardsToSql.mjs <data repo clone> > boards.sql
//   npx wrangler d1 execute driver-leaderboard --remote --file=boards.sql   (from worker/)

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentVehicleId } from '../../src/lib/vehicles/legacyIds.js';

const root = process.argv[2];
if (!root) {
  console.error('Usage: node worker/scripts/boardsToSql.mjs <data repo clone>');
  process.exit(1);
}

const sql = (v) => (typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`);

function* boardFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* boardFiles(path);
    else if (entry.name.endsWith('.json')) yield path;
  }
}

let boards = 0;
let rows = 0;
for (const file of boardFiles(join(root, 'rally'))) {
  const board = JSON.parse(readFileSync(file, 'utf8'));
  if (!board.stage || !board.fingerprint || !Array.isArray(board.entries)) continue;
  console.log(`INSERT OR REPLACE INTO boards (stage, fingerprint) VALUES (${sql(board.stage)}, ${sql(board.fingerprint)});`);
  boards++;
  // Fastest first, so the first entry per player + (renamed) vehicle is their best.
  const best = new Map();
  for (const e of [...board.entries].sort((a, b) => a.totalMs - b.totalMs)) {
    const vehicle = currentVehicleId(e.vehicle);
    if (!best.has(`${e.player}|${vehicle}`)) best.set(`${e.player}|${vehicle}`, { ...e, vehicle });
  }
  for (const e of best.values()) {
    const values = [board.stage, e.player, e.vehicle, e.name ?? 'Player', e.totalMs, JSON.stringify(e.splits ?? []), e.penaltyMs ?? 0, e.at, e.version ?? ''];
    console.log(`INSERT OR REPLACE INTO entries (stage, player, vehicle, name, total_ms, splits, penalty_ms, at, version) VALUES (${values.map(sql).join(', ')});`);
    rows++;
  }
}
console.error(`${boards} boards, ${rows} entries`);
