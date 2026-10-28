// Startup overlay shown until terrain.init() and the gameplay layers resolve: live steps from
// TerrainManager.getLoadProgress() and loadGameplayLayers() so a slow tile server doesn't look like a hang.

const POLL_MS = 150;
const SLOW_AFTER_MS = 15000;
const TERRAIN_SHARE = 0.6; // of the bar; the rest is the gameplay layers (roads, water, buildings)

export function createLoadingScreen(terrain, { lat, lon }) {
  const root = document.getElementById('loading-screen');
  delete root.dataset.booting;
  root.querySelector('h1').textContent = 'Loading real-world terrain';
  const coords = root.querySelector('.loading-coords');
  const baselineStep = root.querySelector('[data-step="baseline"]');
  const groundStep = root.querySelector('[data-step="ground"]');
  const farStep = root.querySelector('[data-step="far"]');
  const gameplayStep = root.querySelector('[data-step="gameplay"]');
  let gameplayState = 'pending';
  let gameplayFraction = 0;
  const bar = root.querySelector('.loading-bar-fill');
  const footer = root.querySelector('.loading-footer');
  const slowHint = root.querySelector('.loading-slow');

  coords.textContent = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
  const startedAt = performance.now();

  function setStep(el, state, detail = '') {
    el.dataset.state = state;
    el.querySelector('.loading-step-detail').textContent = detail;
  }

  function render() {
    const p = terrain.getLoadProgress();
    setStep(baselineStep, p.baselineReady ? 'done' : 'active');
    const groundDone = p.physicsLoaded === p.physicsTotal;
    setStep(groundStep, !p.baselineReady ? 'pending' : groundDone ? 'done' : 'active', `${p.physicsLoaded} / ${p.physicsTotal} tiles`);
    setStep(farStep, p.baselineReady ? 'active' : 'pending', `${p.farLoaded} tiles`);
    setStep(gameplayStep, gameplayState, gameplayState === 'active' ? `${Math.round(gameplayFraction * 100)}%` : '');
    // Baseline is one fetch; weight it as one ground tile.
    const terrainFraction = gameplayState === 'pending' ? ((p.baselineReady ? 1 : 0) + p.physicsLoaded) / (p.physicsTotal + 1) : 1;
    const fraction = terrainFraction * TERRAIN_SHARE + gameplayFraction * (1 - TERRAIN_SHARE);
    bar.style.width = `${Math.round(fraction * 100)}%`;
    const elapsed = performance.now() - startedAt;
    footer.textContent = `${p.inFlight} download${p.inFlight === 1 ? '' : 's'} in flight · ${(elapsed / 1000).toFixed(1)} s`;
    slowHint.hidden = elapsed < SLOW_AFTER_MS;
  }

  render();
  const timer = setInterval(render, POLL_MS);

  function hide() {
    clearInterval(timer);
    root.remove();
  }

  /** Gameplay layers step: 'pending' | 'active' | 'done'. */
  function setGameplayState(state) {
    gameplayState = state;
    render();
  }

  /** Gameplay layers progress, 0..1 (loadGameplayLayers onProgress). */
  function setGameplayProgress(fraction) {
    gameplayFraction = fraction;
  }

  return { hide, setGameplayState, setGameplayProgress };
}
