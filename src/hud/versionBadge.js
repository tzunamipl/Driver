// Tiny version/build badge in the bottom-right corner. Version comes from
// package.json (see vite.config.js's `define`), with the build timestamp
// appended - "YY.MM.DD-HH.MM", UTC, stamped at `vite build` time on GitHub
// Actions - so a deployed GitHub Pages build can always be traced back to
// exactly when it was produced. In dev (`vite dev`) there's no real
// "build", so __BUILD_TIME__ is empty and only the bare version shows.
// Also shown under the main menu's buttons, which cover the badge.
export function createVersionBadge() {
  const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
  const buildTime = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
  const text = buildTime ? `v${version}_${buildTime}` : `v${version}`;
  for (const el of document.querySelectorAll('#version-text, #main-menu .menu-version')) el.textContent = text;
}
