import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const mqttBrowser = fileURLToPath(new URL('./node_modules/mqtt/dist/mqtt.esm.js', import.meta.url));
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));

// Build-time stamp, "YY-MM-DD-HH-MM" (UTC, so it's unambiguous regardless
// of the CI runner's local timezone). Evaluated once when this config
// loads, i.e. at the moment `vite build` runs on GitHub Actions - not at
// request/render time - so it reflects when the deployed bundle was
// actually built (see src/hud/versionBadge.js for where it's displayed).
function buildTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [
    String(d.getUTCFullYear()).slice(-2),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
    pad(d.getUTCHours()),
    pad(d.getUTCMinutes()),
  ].join('-');
}

export default defineConfig(({ command }) => ({
  // Project page: https://tzunamipl.github.io/Driver/
  // Dev server stays at / so local URLs don't grow a repo prefix.
  base: command === 'build' ? '/Driver/' : '/',
  resolve: {
    alias: {
      mqtt: mqttBrowser,
    },
  },
  define: {
    // Replaced at build time (see src/hud/versionBadge.js). In dev mode
    // there's no meaningful "build", so the timestamp is left empty and
    // the badge falls back to showing just the bare version.
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(command === 'build' ? buildTimestamp() : ''),
  },
}));
