import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const mqttBrowser = fileURLToPath(new URL('./node_modules/mqtt/dist/mqtt.esm.js', import.meta.url));

export default defineConfig(({ command }) => ({
  // Project page: https://tzunamipl.github.io/Driver/
  // Dev server stays at / so local URLs don't grow a repo prefix.
  base: command === 'build' ? '/Driver/' : '/',
  resolve: {
    alias: {
      mqtt: mqttBrowser,
    },
  },
}));
