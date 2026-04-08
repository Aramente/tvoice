// Special key toolbar: sticky modifiers, AI context row, expand row,
// data-key / data-sticky / data-ai / data-tool button dispatching.

// Standard xterm key sequences
const KEY_SEQUENCES = {
  Escape: '\x1b',
  Tab: '\t',
  Enter: '\r',
  Backspace: '\x7f',
  ArrowUp: '\x1bOA',
  ArrowDown: '\x1bOB',
  ArrowRight: '\x1bOC',
  ArrowLeft: '\x1bOD',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Delete: '\x1b[3~',
};

// Ctrl+letter -> control character
function ctrlOf(ch) {
  const c = ch.toLowerCase();
  if (c >= 'a' && c <= 'z') {
    return String.fromCharCode(c.charCodeAt(0) - 96);
  }
  // Ctrl+specials
  const map = {
    ' ': '\x00',
    '[': '\x1b',
    ']': '\x1d',
    '\\': '\x1c',
    '/': '\x1f',
  };
  return map[c] || ch;
}

// Alt+char -> ESC + char
function altOf(ch) {
  return '\x1b' + ch;
}

export class KeyToolbar {
  constructor({ root, terminalSession, onExpand, onAI }) {
    this.root = root;
    this.session = terminalSession;
    this.onExpand = onExpand || (() => {});
    this.onAI = onAI || (() => {});
    this.sticky = { Ctrl: false, Alt: false };
    this.expanded = false;
    this.aiActive = false;
    this.aiAwaiting = false;
  }

  mount() {
    this.root.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest('.key');
      if (!btn) return;
      // Prevent the button from stealing focus from the terminal
      e.preventDefault();
    });
    this.root.addEventListener('click', (e) => {
      const btn = e.target.closest('.key');
      if (!btn) return;
      this._handleClick(btn);
    });

    // Attach swipe-up on the primary row to toggle expanded
    const primary = this.root.querySelector('.primary-row');
    if (primary) this._attachExpandGesture(primary);
  }

  setAIActive(active) {
    this.aiActive = !!active;
    this.root.classList.toggle('ai-active', this.aiActive);
    const aiRow = this.root.querySelector('.ai-row');
    if (aiRow) aiRow.setAttribute('aria-hidden', this.aiActive ? 'false' : 'true');
  }
  setAIAwaiting(awaiting) {
    this.aiAwaiting = !!awaiting;
    this.root.classList.toggle('ai-awaiting', this.aiAwaiting);
  }

  _handleClick(btn) {
    const key = btn.dataset.key;
    const sticky = btn.dataset.sticky;
    const ai = btn.dataset.ai;
    const tool = btn.dataset.tool;

    if (sticky) {
      this.sticky[sticky] = !this.sticky[sticky];
      btn.setAttribute('aria-pressed', this.sticky[sticky] ? 'true' : 'false');
      return;
    }

    if (tool) {
      if (tool === 'expand') {
        this.expanded = !this.expanded;
        this.root.classList.toggle('expanded', this.expanded);
        btn.setAttribute('aria-expanded', this.expanded ? 'true' : 'false');
        this.onExpand(this.expanded);
      } else {
        // Delegate tool buttons (voice, snippets) to app
        this.onAI({ tool });
      }
      return;
    }

    if (ai) {
      this._handleAI(ai);
      return;
    }

    if (key) {
      const payload = this._resolveKey(key);
      if (payload !== null && this.session) {
        this.session.sendInput(payload);
      }
    }
  }

  _handleAI(action) {
    switch (action) {
      case 'yes':
        this.session?.sendInput('y\r');
        this.setAIAwaiting(false);
        break;
      case 'no':
        this.session?.sendInput('n\r');
        this.setAIAwaiting(false);
        break;
      case 'collapse':
        this.onAI({ ai: 'collapse' });
        break;
      case 'scroll-ai':
        this.onAI({ ai: 'scroll-ai' });
        break;
    }
  }

  // Map a virtual key name (or literal character) to a terminal byte sequence,
  // applying sticky Ctrl/Alt modifiers and consuming them after use.
  _resolveKey(key) {
    let base;
    if (key === 'C-c') return '\x03';
    if (key === 'C-z') return '\x1a';
    if (key === 'C-d') return '\x04';

    if (KEY_SEQUENCES[key]) {
      base = KEY_SEQUENCES[key];
    } else if (key.length === 1) {
      base = key;
    } else {
      return null;
    }

    // Apply sticky modifiers (ctrl wins over alt if both are set, then alt)
    if (this.sticky.Ctrl && base.length === 1) {
      base = ctrlOf(base);
    }
    if (this.sticky.Alt) {
      base = altOf(base);
    }
    // Consume stickies
    if (this.sticky.Ctrl) {
      this.sticky.Ctrl = false;
      const stickyBtn = this.root.querySelector('#sticky-ctrl');
      if (stickyBtn) stickyBtn.setAttribute('aria-pressed', 'false');
    }
    if (this.sticky.Alt) {
      this.sticky.Alt = false;
      const stickyBtn = this.root.querySelector('#sticky-alt');
      if (stickyBtn) stickyBtn.setAttribute('aria-pressed', 'false');
    }
    return base;
  }

  _attachExpandGesture(el) {
    let startY = null;
    el.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY;
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (startY === null) return;
      const dy = startY - e.changedTouches[0].clientY;
      if (dy > 30) {
        this._setExpanded(true);
      } else if (dy < -30) {
        this._setExpanded(false);
      }
      startY = null;
    }, { passive: true });

    // Also handle a plain tap on the swipe grip as a toggle (accessibility +
    // users who don't discover the swipe).
    const grip = this.root.querySelector('.swipe-grip');
    if (grip) {
      grip.addEventListener('click', () => this._setExpanded(!this.expanded));
    }
  }

  _setExpanded(next) {
    this.expanded = !!next;
    this.root.classList.toggle('expanded', this.expanded);
    const expandedRow = this.root.querySelector('.expanded-row');
    if (expandedRow) expandedRow.setAttribute('aria-hidden', this.expanded ? 'false' : 'true');
    this.onExpand(this.expanded);
  }
}
