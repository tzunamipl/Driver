// Graphics detail: share of particles every emitter actually spawns (1 = all, 0 = none).

let share = 1;

export function setParticleShare(value) {
  share = value;
}

/** Asked once per particle about to spawn. */
export function keepParticle() {
  return share >= 1 || Math.random() < share;
}
