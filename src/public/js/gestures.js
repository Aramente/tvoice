// Touch gestures: swipe left/right to switch tabs, pinch to zoom font size,
// three-finger tap to paste, long-press to select the word under the finger
// (iOS-native-style — the app layer then shows drag handles to extend).

export function setupGestures({
  host,
  onSwipeLeft,
  onSwipeRight,
  onPinch,
  onThreeFingerTap,
  onLongPress,
  onTapOutsideSelection,
  onScroll,
  isSelectionActive,
}) {
  let pointers = new Map();
  let startDist = 0;
  let startTime = 0;
  let startX = 0, startY = 0;
  let pinched = false;
  let longPressTimer = null;
  let longPressFired = false;
  let scrolling = false;
  let lastY = 0;

  const LONG_PRESS_MS = 350;
  const MOVE_CANCEL_PX = 12;
  const SCROLL_START_PX = 14;   // vertical drag must exceed this to start a scroll
  const SCROLL_DOMINANCE = 1.3; // dy must be > dx * 1.3 to count as vertical

  host.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      startDist = distance(pointers);
      pinched = false;
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (typeof onPinch === 'function') onPinch({ phase: 'start' });
    }
    if (pointers.size === 1) {
      startTime = Date.now();
      startX = e.clientX;
      startY = e.clientY;
      lastY = e.clientY;
      scrolling = false;
      longPressFired = false;
      // Long-press starts a word selection via onLongPress. The app layer
      // is responsible for detecting the word under the finger and showing
      // drag handles.
      if (typeof onLongPress === 'function') {
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          if (pointers.size === 1 && !scrolling) {
            longPressFired = true;
            onLongPress({ x: startX, y: startY });
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

    // Scroll: vertical drag that's mostly vertical and past the start
    // threshold. Once in scroll mode, every move feeds an onScroll(delta)
    // callback that the app translates into term.scrollLines().
    if (pointers.size === 1 && !pinched && !longPressFired) {
      const dxTotal = e.clientX - startX;
      const dyTotal = e.clientY - startY;
      if (!scrolling &&
          Math.abs(dyTotal) > SCROLL_START_PX &&
          Math.abs(dyTotal) > Math.abs(dxTotal) * SCROLL_DOMINANCE) {
        scrolling = true;
        // Cancel the long-press timer — vertical drag is clearly not a tap
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      }
      if (scrolling) {
        const dy = e.clientY - lastY;
        lastY = e.clientY;
        if (typeof onScroll === 'function') onScroll(dy);
        return;
      }
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
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    // If we were in scroll mode, just end it — don't count this as a
    // tap or swipe.
    if (scrolling) {
      scrolling = false;
      pointers.delete(e.pointerId);
      return;
    }
    if (pointers.size === 1 && !pinched && !longPressFired) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dt = Date.now() - startTime;
      // Swipe
      if (dt < 500 && Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        if (dx < 0 && typeof onSwipeLeft === 'function') onSwipeLeft();
        if (dx > 0 && typeof onSwipeRight === 'function') onSwipeRight();
      }
      // Tap-outside-selection clears any active selection
      else if (dt < 250 && Math.abs(dx) < 15 && Math.abs(dy) < 15) {
        if (typeof isSelectionActive === 'function' && isSelectionActive()) {
          if (typeof onTapOutsideSelection === 'function') {
            onTapOutsideSelection({ x: e.clientX, y: e.clientY });
          }
        }
      }
    }
    longPressFired = false;
    pointers.delete(e.pointerId);
    if (pointers.size < 2 && pinched) {
      pinched = false;
      if (typeof onPinch === 'function') onPinch({ phase: 'end' });
    }
  });

  host.addEventListener('pointercancel', (e) => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    longPressFired = false;
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
