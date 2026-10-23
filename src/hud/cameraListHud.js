// Brief list of camera views beside the Navigation tab, shown on a view change.

const SHOW_MS = 1500;

export function createCameraListHud(parent = document.getElementById('top-left-row')) {
  const el = document.createElement('ol');
  el.id = 'camera-list';
  parent.appendChild(el);
  let hideTimer = null;

  /** `views` = the selectable views in cycle order; `activeId` is highlighted. */
  function show(views, activeId) {
    el.replaceChildren(
      ...views.map((view) => {
        const item = document.createElement('li');
        item.textContent = view.label;
        item.classList.toggle('active', view.id === activeId);
        return item;
      })
    );
    el.classList.add('visible');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => el.classList.remove('visible'), SHOW_MS);
  }

  return { show };
}
