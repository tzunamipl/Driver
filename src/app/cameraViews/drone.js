// Drone: a free-flying object with its own velocity that keeps sweeping from
// side to side around the car; speed gradually narrows the sweep behind the car
// and pulls it closer so it ends up looking down the direction of travel.
export default {
  id: 'drone',
  label: 'Drone',
  drone: true,
  lookAtSpeed: 2,
  reactionTime: 1, // s; how late it reacts to the car's speed/heading changes
  orbitRadius: 14,
  orbitHeight: 5,
  sweepRate: 0.09, // rad/s of sweep phase (one side-to-side cycle ≈ 35 s, pace drifts ±50%)
  sideSwingSlow: 2.6, // rad either side of directly behind when slow (reaches the front quarters)
  sideSwingFast: 1.2, // rad either side of directly behind at full follow (out to the sides)
  radiusWander: 0.35, // ± fraction of radius
  heightWander: 0.5, // ± fraction of height
  groundClearance: 3, // m; never lower than this above the terrain
  swoopRadius: 0.4, // fraction of radius during an occasional low, close pass
  swoopHeight: 3, // m above the car during a swoop
  followDistance: 15,
  followHeight: 4.5,
  followMinSpeed: 6, // m/s; below this the drone wanders freely
  followMaxSpeed: 55, // m/s (~200 km/h); above this it is fully in follow mode
  lookAhead: 20, // m ahead of the car it aims at full follow
  carryMin: 0.0, // share of the car's velocity it inherits when slow (rest it must chase)
  carryFullSpeed: 0, // m/s; from here it inherits all of it, so it never falls behind
  steer: 1.8, // 1/s, position error -> desired velocity
  maxAccel: 35, // m/s²
  maxOwnSpeed: 55, // m/s on top of the car's speed
};
