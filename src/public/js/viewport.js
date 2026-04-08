// visualViewport handling — keeps the key toolbar docked above the virtual
// keyboard, tells the terminal to refit when the available height changes.

export function setupViewport({ onResize }) {
  const root = document.documentElement;
  const vv = window.visualViewport;

  function applyOffset() {
    const keyboard = vv
      ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      : 0;
    root.style.setProperty('--keyboard-offset', `${keyboard}px`);
    if (typeof onResize === 'function') onResize();
  }

  if (vv) {
    vv.addEventListener('resize', applyOffset);
    vv.addEventListener('scroll', applyOffset);
  } else {
    window.addEventListener('resize', applyOffset);
  }
  window.addEventListener('orientationchange', () => setTimeout(applyOffset, 100));

  applyOffset();

  return { refresh: applyOffset };
}
