// Startup overlay shown until terrain.init() and the gameplay layers resolve: live steps from
// TerrainManager.getLoadProgress() so a slow tile server doesn't look like a hang.

const POLL_MS = 150;
const SLOW_AFTER_MS = 15000;

export function createLoadingScreen(terrain, { lat, lon }) {
  const root = document.getElementById('loading-screen');
  const coords = root.querySelector('.loading-coords');
  const baselineStep = root.querySelector('[data-step="baseline"]');
  const groundStep = root.querySelector('[data-step="ground"]');
  const farStep = root.querySelector('[data-step="far"]');
  const gameplayStep = root.querySelector('[data-step="gameplay"]');
  let gameplayState = 'pending';
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
    setStep(gameplayStep, gameplayState);
    // Baseline is one fetch; weight it as one ground tile.
    const fraction = ((p.baselineReady ? 1 : 0) + p.physicsLoaded) / (p.physicsTotal + 1);
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

  return { hide, setGameplayState };
}
