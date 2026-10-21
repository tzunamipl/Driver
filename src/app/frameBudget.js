// One per-frame time budget for every streamer's main-thread work, spent in
// priority order. Terrain (ground + physics) is not on it: its tile installs
// always run, so the car never waits for the ground behind cosmetics.

export const Tier = {
  GAMEPLAY: 1, // changes how the car behaves (collisions)
  COSMETIC: 2, // only looks; pops in later on slow machines
};

/**
 * Tasks are `step(deadline)`: called every frame (for bookkeeping), building only until `deadline`.
 * `onStep(name)` runs after each task (profiling).
 */
export function createFrameBudget(budgetMs, onStep = () => {}) {
  const tiers = new Map([
    [Tier.GAMEPLAY, []],
    [Tier.COSMETIC, []],
  ]);
  let frame = 0;

  return {
    setBudgetMs(ms) {
      budgetMs = ms;
    },

    add(tier, name, step) {
      tiers.get(tier).push({ name, step });
    },

    run() {
      const deadline = performance.now() + budgetMs;
      for (const { name, step } of tiers.get(Tier.GAMEPLAY)) {
        step(deadline);
        onStep(name);
      }
      // Rotated, so the first cosmetic task can't starve the rest.
      const cosmetic = tiers.get(Tier.COSMETIC);
      const start = frame++ % Math.max(1, cosmetic.length);
      for (let i = 0; i < cosmetic.length; i++) {
        const { name, step } = cosmetic[(start + i) % cosmetic.length];
        step(deadline);
        onStep(name);
      }
    },
  };
}
