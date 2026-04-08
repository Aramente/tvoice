// Touch gestures: swipe left/right across the terminal host to switch tabs,
// pinch to zoom font size, three-finger tap to paste.

export function setupGestures({ host, onSwipeLeft, onSwipeRight, onPinch, onThreeFingerTap }) {
  let pointers = new Map();
  let startDist = 0;
  let startFontSize = 14;
  let startTime = 0;
  let startX = 0, startY = 0;
  let pinched = false;

  host.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      startDist = distance(pointers);
      pinched = false;
      if (typeof onPinch === 'function') onPinch({ phase: 'start' });
    }
    if (pointers.size === 1) {
      startTime = Date.now();
      startX = e.clientX;
      startY = e.clientY;
    }
  });

  host.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && typeof onPinch === 'function') {
      const d = distance(pointers);
      const ratio = d / startDist;
      pinched = true;
      onPinch({ phase: 'move', ratio });
    }
  });

  host.addEventListener('pointerup', (e) => {
    if (pointers.size === 1 && !pinched) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dt = Date.now() - startTime;
      if (dt < 500 && Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        if (dx < 0 && typeof onSwipeLeft === 'function') onSwipeLeft();
        if (dx > 0 && typeof onSwipeRight === 'function') onSwipeRight();
      }
    }
    pointers.delete(e.pointerId);
    if (pointers.size < 2 && pinched) {
      pinched = false;
      if (typeof onPinch === 'function') onPinch({ phase: 'end' });
    }
  });

  host.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
  });

  // Three-finger tap detection via touchstart (pointer events don't model
  // multi-finger taps cleanly on iOS).
  host.addEventListener('touchstart', (e) => {
    if (e.touches.length === 3 && typeof onThreeFingerTap === 'function') {
      e.preventDefault();
      onThreeFingerTap();
    }
  }, { passive: false });
}

function distance(pointers) {
  const [a, b] = Array.from(pointers.values());
  return Math.hypot(a.x - b.x, a.y - b.y);
}
