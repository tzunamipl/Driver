// Scenario file `meta`: who made the file and who last changed it, when, and with which game build:
// { createdBy, createdAt, editedBy, editedAt, version, build } (ISO dates; any may be missing on older files).
// The editor stamps it on save only when the rest of the file changed, so saving a file as is still commits nothing.

const META_FIELDS = ['createdBy', 'createdAt', 'editedBy', 'editedAt', 'version', 'build'];

/** A file's `meta`, its known string fields only; null when it has none. */
export function readMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const out = Object.fromEntries(META_FIELDS.filter((k) => typeof meta[k] === 'string' && meta[k]).map((k) => [k, meta[k]]));
  return Object.keys(out).length ? out : null;
}

function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

/** Hash of a file's content without its `meta`, as the editor writes it. */
export function bodyHash(file) {
  const { meta: _meta, ...body } = file ?? {};
  return hash(JSON.stringify(body, null, 2));
}

/**
 * The file with `meta` as it should be saved: kept when only `meta` would change, else edited by `name` now
 * with this build (created too when `isNew`: a file not opened from this key).
 */
export function stampMeta(file, { meta, baseHash, isNew, name }) {
  const { meta: _meta, ...body } = file;
  const unchanged = !isNew && bodyHash(body) === baseHash;
  const by = String(name ?? '').trim() || 'unknown';
  const now = new Date().toISOString();
  const next = unchanged
    ? meta
    : readMeta({
        ...(isNew ? { createdBy: by, createdAt: now } : meta),
        editedBy: by,
        editedAt: now,
        version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
        build: typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '',
      });
  if (!next) return body;
  // `meta` right after the file's name fields, where readers look first.
  const { format, country, region, id, name: fileName, ...rest } = body;
  return { format, country, region, id, name: fileName, meta: next, ...rest };
}
