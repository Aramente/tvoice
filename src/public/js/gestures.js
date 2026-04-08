// Touch gestures: swipe left/right across the terminal host to switch tabs,
// pinch to zoom font size, three-finger tap to paste, double-tap to copy line,
// long-press to start a drag-selection.

export function setupGestures({
  host,
  onSwipeLeft,
  onSwipeRight,
  onPinch,
  onThreeFingerTap,
  onDoubleTap,
  onSelectStart,
  onSelectMove,
  onSelectEnd,
}) {
  let pointers = new Map();
  let startDist = 0;
  let startFontSize = 14;
  let startTime = 0;
  let startX = 0, startY = 0;
  let pinched = false;
  let lastTapTime = 0;
  let lastTapX = 0, lastTapY = 0;
  let longPressTimer = null;
  let selecting = false;

  const LONG_PRESS_MS = 450;
  const MOVE_CANCEL_PX = 10;

  host.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      startDist = distance(pointers);
      pinched = false;
      // Cancel any in-progress long-press when a second finger lands
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (typeof onPinch === 'function') onPinch({ phase: 'start' });
    }
    if (pointers.size === 1) {
      startTime = Date.now();
      startX = e.clientX;
      startY = e.clientY;
      // Start long-press timer — fires if the finger hasn't moved after LONG_PRESS_MS
      if (typeof onSelectStart === 'function') {
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          if (pointers.size === 1) {
            selecting = true;
            onSelectStart({ x: startX, y: startY });
          }
        }, LONG_PRESS_MS);
      }
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
      return;
    }
    // Extend active selection
    if (selecting && typeof onSelectMove === 'function') {
      onSelectMove({ x: e.clientX, y: e.clientY });
      return;
    }
    // Cancel long-press if the finger moved too much before it fired
    if (longPressTimer) {
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    }
  });

  host.addEventListener('pointerup', (e) => {
    // Cancel any outstanding long-press timer
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    // Finalize active selection
    if (selecting) {
      if (typeof onSelectEnd === 'function') onSelectEnd();
      selecting = false;
      pointers.delete(e.pointerId);
      return;
    }
    if (pointers.size === 1 && !pinched) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dt = Date.now() - startTime;
      // Swipe
      if (dt < 500 && Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        if (dx < 0 && typeof onSwipeLeft === 'function') onSwipeLeft();
        if (dx > 0 && typeof onSwipeRight === 'function') onSwipeRight();
      }
      // Double-tap
      else if (dt < 250 && Math.abs(dx) < 15 && Math.abs(dy) < 15) {
        const now = Date.now();
        const dxFromLast = Math.abs(e.clientX - lastTapX);
        const dyFromLast = Math.abs(e.clientY - lastTapY);
        if (now - lastTapTime < 350 && dxFromLast < 30 && dyFromLast < 30) {
          if (typeof onDoubleTap === 'function') {
            onDoubleTap({ x: e.clientX, y: e.clientY });
          }
          lastTapTime = 0;
        } else {
          lastTapTime = now;
          lastTapX = e.clientX;
          lastTapY = e.clientY;
        }
      }
    }
    pointers.delete(e.pointerId);
    if (pointers.size < 2 && pinched) {
      pinched = false;
      if (typeof onPinch === 'function') onPinch({ phase: 'end' });
    }
  });

  host.addEventListener('pointercancel', (e) => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    if (selecting) {
      selecting = false;
      if (typeof onSelectEnd === 'function') onSelectEnd({ cancelled: true });
    }
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
