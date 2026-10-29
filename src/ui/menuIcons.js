// Win95-style 16x16 icons as inline SVG markup, keyed by main menu action / game mode id / editor action.

const OUTLINE = 'stroke="#000" stroke-width="1"';

const checks = () => {
  let out = '';
  for (let row = 0; row < 4; row++) for (let col = 0; col < 6; col++) {
    if ((row + col) % 2 === 0) out += `<rect x="${4 + col * 2}" y="${2 + row * 2}" width="2" height="2" fill="#000"/>`;
  }
  return out;
};

const ICONS = {
  continue: `<path d="M4.5 2.5 L13 8 L4.5 13.5 Z" fill="#00a000" ${OUTLINE} stroke-linejoin="round"/>`,
  save: `<rect x="1.5" y="1.5" width="13" height="13" fill="#000080" ${OUTLINE}/>
    <rect x="4" y="2" width="8" height="5" fill="#c0c0c0"/><rect x="9" y="2.5" width="2" height="3.5" fill="#000080"/>
    <rect x="3" y="9" width="10" height="5" fill="#fff"/><path d="M4 11 H12 M4 12.5 H10" stroke="#808080"/>`,
  modes: `<circle cx="8" cy="8" r="6" fill="none" stroke="#000" stroke-width="2.5"/>
    <circle cx="8" cy="8" r="6" fill="none" stroke="#606060" stroke-width="1"/>
    <path d="M2.5 8 H13.5 M8 8 V13.5" stroke="#000" stroke-width="2"/><circle cx="8" cy="8" r="2" fill="#c00000" ${OUTLINE}/>`,
  settings: `<g fill="#808080" stroke="#000" stroke-width="0.6">
      <rect x="6.5" y="1" width="3" height="14"/><rect x="6.5" y="1" width="3" height="14" transform="rotate(45 8 8)"/>
      <rect x="6.5" y="1" width="3" height="14" transform="rotate(90 8 8)"/><rect x="6.5" y="1" width="3" height="14" transform="rotate(135 8 8)"/>
    </g><circle cx="8" cy="8" r="4.8" fill="#c0c0c0" ${OUTLINE}/><circle cx="8" cy="8" r="1.8" fill="#fff" ${OUTLINE}/>`,
  new: `<path d="M3.5 1.5 H10 L12.5 4 V14.5 H3.5 Z" fill="#fff" ${OUTLINE}/><path d="M10 1.5 V4 H12.5" fill="#c0c0c0" ${OUTLINE}/>
    <path d="M8 6.5 V12.5 M5 9.5 H11" stroke="#00a000" stroke-width="2"/>`,
  editor: `<path d="M3 13 L4 9.5 L11 2.5 L13.5 5 L6.5 12 Z" fill="#ffd000" ${OUTLINE} stroke-linejoin="round"/>
    <path d="M11 2.5 L13.5 5 L14.5 4 C15 3.5 15 3 14.5 2.5 L13.5 1.5 C13 1 12.5 1 12 1.5 Z" fill="#e080a0" ${OUTLINE}/>
    <path d="M3 13 L4 9.5 L6.5 12 Z" fill="#e8c898" ${OUTLINE}/><path d="M2.5 13.5 L3.3 12.7" stroke="#000" stroke-width="1.5"/>`,
  about: `<circle cx="8" cy="8" r="6.5" fill="#0000c0" ${OUTLINE}/>
    <rect x="7" y="7" width="2" height="5" fill="#fff"/><rect x="7" y="4" width="2" height="2" fill="#fff"/>`,

  freeRoam: `<circle cx="8" cy="8" r="6.5" fill="#3a8fd8" ${OUTLINE}/>
    <path d="M4 4.5 C5.5 3.5 7 4 7.5 5.5 C7 7 5 7 5.5 9 C5 10.5 3 10 2.2 8 C2 6.5 3 5.2 4 4.5 Z M9.5 2.5 C11 2.5 13 4 13.5 6 C12.5 7 11 6 10 7.5 C10.5 9.5 12.5 10 12 12 C10.5 13.5 9 13 8.5 11.5 C8 10 8.5 9 8 7.5 C7.5 6 9 4 9.5 2.5 Z" fill="#20a040"/>
    <ellipse cx="8" cy="8" rx="3" ry="6.5" fill="none" stroke="#000" stroke-width="0.5" opacity="0.5"/>
    <path d="M1.5 8 H14.5" stroke="#000" stroke-width="0.5" opacity="0.5"/>`,
  rally: `<rect x="2.5" y="1" width="1.5" height="14" fill="#804000" ${OUTLINE} stroke-width="0.5"/>
    <rect x="4" y="2" width="12" height="8" fill="#fff" ${OUTLINE} stroke-width="0.5"/>${checks()}`,
  honestWork: `<rect x="0.5" y="3.5" width="9" height="7.5" fill="#e0a000" ${OUTLINE}/>
    <path d="M9.5 5.5 H13 L15.5 8.5 V11 H9.5 Z" fill="#c00000" ${OUTLINE}/><path d="M10.5 6.5 H12.5 L14 8.5 H10.5 Z" fill="#a0e0ff"/>
    <circle cx="4" cy="12" r="2" fill="#000"/><circle cx="12.5" cy="12" r="2" fill="#000"/>
    <circle cx="4" cy="12" r="0.8" fill="#c0c0c0"/><circle cx="12.5" cy="12" r="0.8" fill="#c0c0c0"/>`,
  pathsOfHate: `<path d="M8 1.5 C11.5 1.5 13.5 4 13.5 7 C13.5 9 12.5 10 11 10.5 V13.5 H5 V10.5 C3.5 10 2.5 9 2.5 7 C2.5 4 4.5 1.5 8 1.5 Z" fill="#e8e0c8" ${OUTLINE}/>
    <circle cx="5.8" cy="7" r="1.5" fill="#000"/><circle cx="10.2" cy="7" r="1.5" fill="#000"/>
    <path d="M8 8.5 L7 10 H9 Z" fill="#000"/><path d="M6.5 11.5 V13.5 M8 11.5 V13.5 M9.5 11.5 V13.5" stroke="#000" stroke-width="0.6"/>`,
  chariotsOfFire: `<path d="M8 0.8 C9 3.5 13.5 5.5 13.5 10 A5.5 5.5 0 0 1 2.5 10 C2.5 7.5 4 6 5 4 C5.5 5.5 6 6.5 7 7 C7 5 7 3 8 0.8 Z" fill="#e04000" ${OUTLINE}/>
    <path d="M8 6.5 C9 8 11 9 11 11 A3 3 0 0 1 5 11 C5 9.5 6 9 6.5 8 C7 9 7.5 9.3 8 9.5 Z" fill="#ffd000"/>`,

  moveToCar: `<path d="M8 1 V7.5" stroke="#000" stroke-width="2"/><path d="M4.5 6 H11.5 L8 9.5 Z" fill="#000"/>
    <circle cx="8" cy="12.5" r="2.5" fill="#000"/>`,
  delete: `<path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5" stroke="#000" stroke-width="4" stroke-linecap="square"/>
    <path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5" stroke="#e00000" stroke-width="2" stroke-linecap="square"/>`,
  generate: `<path d="M2 14 L10 6" stroke="#000" stroke-width="2.5" stroke-linecap="round"/><path d="M8.8 7.2 L10 6" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M12 1 L12.8 3.2 L15 4 L12.8 4.8 L12 7 L11.2 4.8 L9 4 L11.2 3.2 Z" fill="#ffd000" stroke="#000" stroke-width="0.5"/>
    <path d="M5 2 V5 M3.5 3.5 H6.5 M13 10 V13 M11.5 11.5 H14.5" stroke="#e0a000" stroke-width="1"/>`,
  add: `<path d="M8 2 V14 M2 8 H14" stroke="#000" stroke-width="5"/><path d="M8 3 V13 M3 8 H13" stroke="#00a000" stroke-width="3"/>`,
  startAt: `<circle cx="8" cy="8" r="5.5" fill="#e00000" ${OUTLINE}/>`,
  endAt: `<rect x="3" y="3" width="10" height="10" fill="#000"/>`,
  goTo: `<path d="M1.5 5.5 H8.5 V2 L14.5 8 L8.5 14 V10.5 H1.5 Z" fill="#00a000" ${OUTLINE} stroke-linejoin="round"/>`,
};

/** `<svg>` element for `id`, or null if it has no icon. */
export function menuIcon(id, className = 'menu-icon') {
  const markup = ICONS[id];
  if (!markup) return null;
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="${className}" viewBox="0 0 16 16" aria-hidden="true">${markup}</svg>`;
  return tpl.content.firstChild;
}
