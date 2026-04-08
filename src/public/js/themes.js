// Terminal color themes. Each theme is an xterm.js ITheme.

const OLED = {
  background: '#0A0A0A',
  foreground: '#E0E0E0',
  cursor: '#E0E0E0',
  cursorAccent: '#0A0A0A',
  selectionBackground: '#264F78',
  black: '#0A0A0A',
  red: '#F87171',
  green: '#4ADE80',
  yellow: '#FBBF24',
  blue: '#60A5FA',
  magenta: '#C084FC',
  cyan: '#22D3EE',
  white: '#E0E0E0',
  brightBlack: '#6b6b6b',
  brightRed: '#FCA5A5',
  brightGreen: '#86EFAC',
  brightYellow: '#FDE68A',
  brightBlue: '#93C5FD',
  brightMagenta: '#D8B4FE',
  brightCyan: '#67E8F9',
  brightWhite: '#FFFFFF',
};

const DRACULA = {
  background: '#282a36', foreground: '#f8f8f2',
  cursor: '#f8f8f2', cursorAccent: '#282a36',
  selectionBackground: '#44475a',
  black: '#21222c', red: '#ff5555', green: '#50fa7b',
  yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6',
  cyan: '#8be9fd', white: '#f8f8f2',
  brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
  brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
  brightCyan: '#a4ffff', brightWhite: '#ffffff',
};

const NORD = {
  background: '#2e3440', foreground: '#d8dee9',
  cursor: '#d8dee9', cursorAccent: '#2e3440',
  selectionBackground: '#434c5e',
  black: '#3b4252', red: '#bf616a', green: '#a3be8c',
  yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead',
  cyan: '#88c0d0', white: '#e5e9f0',
  brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
  brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead',
  brightCyan: '#8fbcbb', brightWhite: '#eceff4',
};

const CATPPUCCIN = {
  background: '#1e1e2e', foreground: '#cdd6f4',
  cursor: '#f5e0dc', cursorAccent: '#1e1e2e',
  selectionBackground: '#585b70',
  black: '#45475a', red: '#f38ba8', green: '#a6e3a1',
  yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7',
  cyan: '#94e2d5', white: '#bac2de',
  brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5', brightWhite: '#a6adc8',
};

const SOLARIZED_DARK = {
  background: '#002b36', foreground: '#839496',
  cursor: '#93a1a1', cursorAccent: '#002b36',
  selectionBackground: '#073642',
  black: '#073642', red: '#dc322f', green: '#859900',
  yellow: '#b58900', blue: '#268bd2', magenta: '#d33682',
  cyan: '#2aa198', white: '#eee8d5',
  brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75',
  brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
};

const THEMES = {
  oled: OLED,
  dracula: DRACULA,
  nord: NORD,
  catppuccin: CATPPUCCIN,
  'solarized-dark': SOLARIZED_DARK,
};

export const ThemeManager = {
  get(name) { return THEMES[name] || OLED; },
  list() { return Object.keys(THEMES); },
  parseCustom(json) {
    try {
      const t = typeof json === 'string' ? JSON.parse(json) : json;
      if (!t.background || !t.foreground) return null;
      return t;
    } catch { return null; }
  },
};
