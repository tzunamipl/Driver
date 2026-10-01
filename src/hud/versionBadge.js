// Tiny version/build badge, centered at the bottom of the screen just
// below the online/offline #net-status pill. Version comes from
// package.json (see vite.config.js's `define`), with the build timestamp
// appended - "YY.MM.DD-HH.MM", UTC, stamped at `vite build` time on GitHub
// Actions - so a deployed GitHub Pages build can always be traced back to
// exactly when it was produced. In dev (`vite dev`) there's no real
// "build", so __BUILD_TIME__ is empty and only the bare version shows.
export function createVersionBadge() {
  const el = document.getElementById('version-badge');
  if (!el) return;
  const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
  const buildTime = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
  el.textContent = buildTime ? `v${version}_${buildTime}` : `v${version}`;
}
