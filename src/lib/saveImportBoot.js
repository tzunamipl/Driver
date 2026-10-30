import { applyQueuedSaveImport } from './saveFile.js';

// First import of main.js: modules that read storage while loading (e.g. units.js) see the imported save.
applyQueuedSaveImport();
