// Folding tree of scenario sources (lib/scenarios/catalog.js): Official, then Players
// (one folder per player branch / fork), each listing its files of the asked kinds by
// country and region / theme. Folders load when first opened. Shared by the rally picker and the editor.

import { listSources, openListed } from '../lib/scenarios/catalog.js';
import { formatSource } from '../lib/scenarios/source.js';
import { filePath, indexPath, splitKey, slugLabel } from '../lib/scenarios/paths.js';
import { reverseKey } from '../lib/rally/stageReverse.js';

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
 * @param {{source: string, kindId: string, key: string} | null} [opts.initialFile] - file to open the folders down to
 *   and pick (source as 'owner/repo@branch'); skipped when gone or something else was picked first.
 * @param {string[]} [opts.reverseKinds] - kinds whose files are listed twice: as authored and driven the other
 *   way (key = lib/rally/stageReverse.js reverseKey, same json).
 * @returns {{el: HTMLElement, reload: () => void}}
 */
export function createScenarioTree({ folder, kinds, onPick, onActivate, ownBranch = () => null, initialFile = null, reverseKinds = [] }) {
  const root = el('div', { className: 'scenario-tree' });
  let selectedButton = null;
  const isInitialSource = (listed) => !!initialFile && formatSource(listed.source) === initialFile.source;

  function restore(button) {
    if (selectedButton) return;
    for (let node = button.parentElement; node && node !== root; node = node.parentElement) {
      if (node.tagName === 'DETAILS') node.open = true;
    }
    button.click();
    button.scrollIntoView({ block: 'nearest' });
  }

  /** The file's button, and its reverse run's after it for `reverseKinds`. */
  function fileButtons(listed, opened, kind, key) {
    const { id } = splitKey(key);
    const variants = [{ key, suffix: '' }, ...(reverseKinds.includes(kind.id) ? [{ key: reverseKey(key), suffix: ' (reverse)' }] : [])];
    const buttons = variants.map(({ suffix }) => el('button', { type: 'button', textContent: `${id}${suffix}`, disabled: true }));
    opened.readJson(filePath(folder, kind, key)).then(
      (json) => {
        if (!json) return;
        variants.forEach((variant, i) => {
          const button = buttons[i];
          button.textContent = `${json.name || id}${variant.suffix}`;
          button.title = key;
          button.disabled = false;
          const picked = { source: listed.source, opened, kindId: kind.id, key: variant.key, json };
          button.onclick = () => {
            selectedButton?.classList.remove('selected');
            selectedButton = button;
            button.classList.add('selected');
            onPick(picked);
          };
          if (onActivate) button.ondblclick = () => onActivate(picked);
          if (isInitialSource(listed) && initialFile.kindId === kind.id && initialFile.key === variant.key) restore(button);
        });
      },
      () => {}
    );
    return buttons;
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
        list.prepend(...[...regions.values()].flat().flatMap((key) => fileButtons(listed, opened, kind, key)));
        continue;
      }
      const regionNodes = [...regions].map(([region, regionKeys]) =>
        folderNode(slugLabel(region), [el('div', { className: 'scenario-tree-files' }, regionKeys.flatMap((key) => fileButtons(listed, opened, kind, key)))])
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
      const official = sources.filter((s) => s.official).map((s) => sourceNode(s, !own || isInitialSource(s)));
      const players = sources.filter((s) => !s.official).map((s) => sourceNode(s, s === own || isInitialSource(s)));
      const playersBody = el('div', { className: 'scenario-tree-body' }, players.length ? players : [note('No player scenarios yet')]);
      root.replaceChildren(...official, el('details', { open: !!own }, [el('summary', { textContent: 'Players' }), playersBody]));
    } catch (err) {
      root.replaceChildren(note(err.message));
    }
  }

  reload();
  return { el: root, reload };
}
