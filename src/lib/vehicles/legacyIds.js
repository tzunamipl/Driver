// Vehicle ids from before the C001 / S001 scheme -> current id, for old saves, leaderboard
// entries and peers. No imports: the worker (worker/src/index.js) bundles it too.
export const LEGACY_VEHICLE_IDS = {
  gc8: 'C001',
  gl: 'C002',
  levorg: 'C003',
  cinquecento: 'C004',
  golf5: 'C005',
  bigfoot: 'C006',
  speeder: 'C007',
  rally: 'C008',
  evo6: 'C009',
  'impreza-22b': 'C010',
  'focus-wrc': 'C011',
  m977: 'C012',
  'actros-8x4': 'C013',
  'scania-r500': 'C014',
  'war-rig': 'C015',
  gigahorse: 'C016',
  interceptor: 'C017',
  'pod-racer-3': 'S001',
};

/** Current id for a possibly legacy one (unknown ids pass through). */
export const currentVehicleId = (id) => (Object.hasOwn(LEGACY_VEHICLE_IDS, id) ? LEGACY_VEHICLE_IDS[id] : id);
