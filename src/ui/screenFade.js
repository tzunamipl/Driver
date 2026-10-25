// Full-screen fade to black and back, with an optional caption while black (e.g. a rally
// liaison transfer). Over the HUD, under the dialogs and the main menu.

const FADE_MS = 700;

export function createScreenFade() {
  const root = document.getElementById('screen-fade');
  const caption = root.appendChild(Object.assign(document.createElement('div'), { className: 'screen-fade-caption' }));
  let seq = 0;

  /** Resolves once the opacity transition is over (or a newer fade took over). */
  function fadeTo(opacity) {
    const mine = ++seq;
    root.hidden = false;
    // Next frame, so a just-unhidden overlay animates from its current opacity.
    requestAnimationFrame(() => {
      if (mine === seq) root.style.opacity = String(opacity);
    });
    return new Promise((resolve) => setTimeout(resolve, FADE_MS + 50)).then(() => {
      if (mine === seq && opacity === 0) root.hidden = true;
    });
  }

  return {
    /** Fades to black, `text` shown on it. */
    out(text = '') {
      caption.textContent = text;
      return fadeTo(1);
    },
    /** Fades back to the game. */
    in() {
      return fadeTo(0);
    },
  };
}
