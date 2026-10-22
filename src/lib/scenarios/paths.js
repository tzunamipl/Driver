// Scenario file layout: <mode>/<country>/<region>/<kind folder>/<id>.json, so a region
// holds its stages and rallies. A file's key (`country/region/id`) is what the index lists
// and rally itineraries reference. Keys without folders (just `id`) are files from before
// countries and regions, at <mode>/<kind folder>/<id>.json.

export const fileKey = ({ country, region, id }) => `${country}/${region}/${id}`;

export function filePath(folder, kind, key) {
  const { country, region, id } = splitKey(key);
  if (!country) return `${folder}/${kind.folder}/${id}.json`;
  return `${folder}/${country}/${region}/${kind.folder}/${id}.json`;
}

export const indexPath = (folder) => `${folder}/index.json`;

/** 'country/region/id' -> { country, region, id }; a bare 'id' (flat layout) has no country / region. */
export function splitKey(key) {
  const parts = String(key).split('/');
  if (parts.length === 1) return { country: '', region: '', id: parts[0] };
  const [country = '', region = '', id = ''] = parts;
  return { country, region, id };
}

/** Slug -> display name: 'lower-silesia' -> 'Lower silesia'. */
export const slugLabel = (slug) => (slug ? slug[0].toUpperCase() + slug.slice(1).replace(/-/g, ' ') : slug);
