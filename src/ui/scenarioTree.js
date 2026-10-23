// Folding tree of scenario sources (lib/scenarios/catalog.js): Official, then Players
// (one folder per player branch / fork), each listing its files of the asked kinds by
// country and region / theme. Folders load when first opened. Shared by the rally picker and the editor.

import { listSources, openListed } from '../lib/scenarios/catalog.js';
import { filePath, indexPath, splitKey, slugLabel } from '../lib/scenarios/paths.js';

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const note = (text) => el('p', { className: 'scenario-tree-note', textContent: text });

/**
 * @param {object} opts
 * @param {string} opts.folder - mode folder, e.g. 'rally'.
 * @param {{id: string, label: string, folder: string, indexKey: string}[]} opts.kinds - file kinds listed per source.
 * @param {(pick: {source: object, opened: object, kindId: string, key: string, json: object}) => void} opts.onPick
 * @param {(pick: object) => void} [opts.onActivate] - double-click, same argument as onPick.
 * @param {() => string | null} [opts.ownBranch] - player's branch: opened instead of Official when listed.
 * @returns {{el: HTMLElement, reload: () => void}}
 */
export function createScenarioTree({ folder, kinds, onPick, onActivate, ownBranch = () => null }) {
  const root = el('div', { className: 'scenario-tree' });
  let selectedButton = null;

  function fileButton(listed, opened, kind, key) {
    const { id } = splitKey(key);
    const button = el('button', { type: 'button', textContent: id, disabled: true });
    opened.readJson(filePath(folder, kind, key)).then(
      (json) => {
        if (!json) return;
        button.textContent = json.name || id;
        button.title = key;
        button.disabled = false;
        const picked = { source: listed.source, opened, kindId: kind.id, key, json };
        button.onclick = () => {
          selectedButton?.classList.remove('selected');
          selectedButton = button;
          button.classList.add('selected');
          onPick(picked);
        };
        if (onActivate) button.ondblclick = () => onActivate(picked);
      },
      () => {}
    );
    return button;
  }

  /** A kind's files, folded by country then region / theme. */
  function kindSection(listed, opened, kind, keys) {
    const list = el('div', { className: 'scenario-tree-files' });
    if (!keys.length) {
      list.append(note('None yet'));
      return list;
    }
    const countries = new Map(); // country -> region -> keys
    for (const key of [...keys].sort()) {
      const { country, region } = splitKey(key);
      if (!countries.has(country)) countries.set(country, new Map());
      const regions = countries.get(country);
      if (!regions.has(region)) regions.set(region, []);
      regions.get(region).push(key);
    }
    const folderNode = (label, children) =>
      el('details', {}, [el('summary', { textContent: label }), el('div', { className: 'scenario-tree-body' }, children)]);
    for (const [country, regions] of countries) {
      // Flat-layout files: listed loose, before the country folders.
      if (!country) {
        list.prepend(...[...regions.values()].flat().map((key) => fileButton(listed, opened, kind, key)));
        continue;
      }
      const regionNodes = [...regions].map(([region, regionKeys]) =>
        folderNode(slugLabel(region), [el('div', { className: 'scenario-tree-files' }, regionKeys.map((key) => fileButton(listed, opened, kind, key)))])
      );
      list.append(folderNode(slugLabel(country), regionNodes));
    }
    return list;
  }

  /** A source's files: one folder per kind when there are several, else a flat list. */
  async function fillSource(body, listed) {
    body.replaceChildren(note('Loading…'));
    try {
      const opened = await openListed(listed);
      const index = (await opened.readJson(indexPath(folder))) ?? {};
      const sections = kinds.map((kind) => {
        const list = kindSection(listed, opened, kind, index[kind.indexKey] ?? []);
        return kinds.length > 1 ? el('details', { open: true }, [el('summary', { textContent: `${kind.label}s` }), list]) : list;
      });
      body.replaceChildren(...sections);
    } catch (err) {
      body.replaceChildren(note(err.message));
    }
  }

  function sourceNode(listed, open) {
    const body = el('div', { className: 'scenario-tree-body' });
    const node = el('details', {}, [el('summary', { textContent: listed.label }), body]);
    let loaded = false;
    node.addEventListener('toggle', () => {
      if (!node.open || loaded) return;
      loaded = true;
      fillSource(body, listed);
    });
    if (open) {
      node.open = true;
      loaded = true;
      fillSource(body, listed);
    }
    return node;
  }

  async function reload() {
    root.replaceChildren(note('Loading…'));
    try {
      const sources = await listSources();
      const branch = ownBranch();
      const own = sources.find((s) => !s.official && s.source.ref === branch);
      const official = sources.filter((s) => s.official).map((s) => sourceNode(s, !own));
      const players = sources.filter((s) => !s.official).map((s) => sourceNode(s, s === own));
      const playersBody = el('div', { className: 'scenario-tree-body' }, players.length ? players : [note('No player scenarios yet')]);
      root.replaceChildren(...official, el('details', { open: !!own }, [el('summary', { textContent: 'Players' }), playersBody]));
    } catch (err) {
      root.replaceChildren(note(err.message));
    }
  }

  reload();
  return { el: root, reload };
}
