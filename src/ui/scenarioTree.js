// Folding tree of scenario sources (lib/scenarios/catalog.js): Official, then Players
// (one folder per player branch / fork), each listing its files of the asked kinds by
// name. Folders load when first opened. Shared by the rally picker and the editor.

import { listSources, openListed } from '../lib/scenarios/catalog.js';

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
 * @param {(pick: {source: object, opened: object, kindId: string, id: string, json: object}) => void} opts.onPick
 * @param {() => string | null} [opts.getToken]
 * @returns {{el: HTMLElement, reload: () => void}}
 */
export function createScenarioTree({ folder, kinds, onPick, getToken = () => null }) {
  const root = el('div', { className: 'scenario-tree' });

  /** A source's files: one folder per kind when there are several, else a flat list. */
  async function fillSource(body, listed) {
    body.replaceChildren(note('Loading…'));
    try {
      const opened = await openListed(listed, getToken());
      const index = (await opened.readJson(`${folder}/index.json`)) ?? {};
      const sections = kinds.map((kind) => {
        const ids = index[kind.indexKey] ?? [];
        const list = el('div', { className: 'scenario-tree-files' });
        if (!ids.length) list.append(note('None yet'));
        for (const id of ids) {
          const button = el('button', { type: 'button', textContent: id, disabled: true });
          list.append(button);
          opened.readJson(`${folder}/${kind.folder}/${id}.json`).then(
            (json) => {
              if (!json) return;
              button.textContent = json.name || id;
              button.title = id;
              button.disabled = false;
              button.onclick = () => onPick({ source: listed.source, opened, kindId: kind.id, id, json });
            },
            () => {}
          );
        }
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
      const sources = await listSources(getToken());
      const official = sources.filter((s) => s.official).map((s) => sourceNode(s, true));
      const players = sources.filter((s) => !s.official).map((s) => sourceNode(s, false));
      const playersBody = el('div', { className: 'scenario-tree-body' }, players.length ? players : [note('No player scenarios yet')]);
      root.replaceChildren(...official, el('details', {}, [el('summary', { textContent: 'Players' }), playersBody]));
    } catch (err) {
      root.replaceChildren(note(err.message));
    }
  }

  reload();
  return { el: root, reload };
}
