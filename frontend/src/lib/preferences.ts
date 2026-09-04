/**
 * Editor preferences.
 *
 * Persisted per browser and applied immediately. Everything here is a display
 * or editing choice; nothing that affects execution safety is settable from the
 * client, which is why limits live on the server instead.
 */

export type ThemeId =
  | 'obsidian'
  | 'cyber-neon'
  | 'matrix'
  | 'paper'
  | 'high-contrast';

export interface Theme {
  id: ThemeId;
  label: string;
  /** Monaco's built-in base this theme derives from. */
  monacoBase: 'vs' | 'vs-dark' | 'hc-black';
  /** CSS custom properties applied to the document root. */
  tokens: Record<string, string>;
  /** Terminal palette. */
  terminal: {
    background: string;
    foreground: string;
    cursor: string;
    selection: string;
  };
}

export const THEMES: Theme[] = [
  {
    id: 'obsidian',
    label: 'Dark Obsidian',
    monacoBase: 'vs-dark',
    tokens: {
      '--cc-bg': '#0b0e14',
      '--cc-panel': '#0e121b',
      '--cc-surface': '#12161f',
      '--cc-border': '#1e293b',
      '--cc-text': '#e2e8f0',
      '--cc-muted': '#64748b',
      '--cc-accent': '#6366f1',
      '--cc-run': '#10b981',
      '--cc-halt': '#ef4444',
      '--cc-caret': '#a855f7',
    },
    terminal: {
      background: '#0b0e14',
      foreground: '#e2e8f0',
      cursor: '#a855f7',
      selection: '#6366f166',
    },
  },
  {
    id: 'cyber-neon',
    label: 'Cyberpunk Neon',
    monacoBase: 'vs-dark',
    tokens: {
      '--cc-bg': '#0a0118',
      '--cc-panel': '#12042a',
      '--cc-surface': '#1a0838',
      '--cc-border': '#3b1a6b',
      '--cc-text': '#f0e6ff',
      '--cc-muted': '#8b6bb1',
      '--cc-accent': '#e935c1',
      '--cc-run': '#00f5d4',
      '--cc-halt': '#ff2e63',
      '--cc-caret': '#00d4ff',
    },
    terminal: {
      background: '#0a0118',
      foreground: '#f0e6ff',
      cursor: '#00d4ff',
      selection: '#e935c166',
    },
  },
  {
    id: 'matrix',
    label: 'Matrix Terminal',
    monacoBase: 'vs-dark',
    tokens: {
      '--cc-bg': '#000700',
      '--cc-panel': '#020d02',
      '--cc-surface': '#041404',
      '--cc-border': '#0f3d0f',
      '--cc-text': '#7dff7d',
      '--cc-muted': '#2f7a2f',
      '--cc-accent': '#00ff41',
      '--cc-run': '#00ff41',
      '--cc-halt': '#ff5555',
      '--cc-caret': '#aaffaa',
    },
    terminal: {
      background: '#000700',
      foreground: '#7dff7d',
      cursor: '#00ff41',
      selection: '#00ff4133',
    },
  },
  {
    id: 'paper',
    label: 'Clean Light',
    monacoBase: 'vs',
    tokens: {
      '--cc-bg': '#fbfbfd',
      '--cc-panel': '#f1f2f6',
      '--cc-surface': '#e8eaf0',
      '--cc-border': '#d0d4de',
      '--cc-text': '#1e2430',
      '--cc-muted': '#6b7280',
      '--cc-accent': '#4f46e5',
      '--cc-run': '#047857',
      '--cc-halt': '#b91c1c',
      '--cc-caret': '#7c3aed',
    },
    terminal: {
      background: '#fbfbfd',
      foreground: '#1e2430',
      cursor: '#7c3aed',
      selection: '#4f46e533',
    },
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    monacoBase: 'hc-black',
    tokens: {
      '--cc-bg': '#000000',
      '--cc-panel': '#000000',
      '--cc-surface': '#0a0a0a',
      '--cc-border': '#6fc3df',
      '--cc-text': '#ffffff',
      '--cc-muted': '#c0c0c0',
      '--cc-accent': '#6fc3df',
      '--cc-run': '#3ff23f',
      '--cc-halt': '#ff3f3f',
      '--cc-caret': '#ffff00',
    },
    terminal: {
      background: '#000000',
      foreground: '#ffffff',
      cursor: '#ffff00',
      selection: '#6fc3df55',
    },
  },
];

export function themeById(id: ThemeId): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]!;
}

export interface Preferences {
  theme: ThemeId;
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  /** Draw a guide column at the conventional line length. */
  rulerColumn: number;
  fontLigatures: boolean;
  /** Re-run static analysis as you type. */
  liveAnalysis: boolean;
  /** Show whitespace characters. */
  renderWhitespace: boolean;
  /** Hide every panel but the editor. */
  zenMode: boolean;
  /** Wall-clock limit requested for a run, in seconds. */
  wallSeconds: number;
  /** Memory ceiling requested for a run, in MiB. */
  memoryMb: number;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'obsidian',
  fontSize: 13,
  tabSize: 4,
  wordWrap: false,
  minimap: true,
  lineNumbers: true,
  rulerColumn: 0,
  fontLigatures: true,
  liveAnalysis: true,
  renderWhitespace: false,
  zenMode: false,
  wallSeconds: 10,
  memoryMb: 256,
};

const STORAGE_KEY = 'codecraft.preferences.v1';

/** Clamp and type-check a stored value, so an old or hand-edited entry cannot
 *  put the editor into an unusable state. */
export function normalisePreferences(raw: unknown): Preferences {
  const source = (raw ?? {}) as Partial<Preferences>;
  const number = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.round(value)))
      : fallback;
  const flag = (value: unknown, fallback: boolean) =>
    typeof value === 'boolean' ? value : fallback;

  return {
    theme: THEMES.some((theme) => theme.id === source.theme)
      ? (source.theme as ThemeId)
      : DEFAULT_PREFERENCES.theme,
    fontSize: number(source.fontSize, DEFAULT_PREFERENCES.fontSize, 9, 28),
    tabSize: number(source.tabSize, DEFAULT_PREFERENCES.tabSize, 1, 8),
    wordWrap: flag(source.wordWrap, DEFAULT_PREFERENCES.wordWrap),
    minimap: flag(source.minimap, DEFAULT_PREFERENCES.minimap),
    lineNumbers: flag(source.lineNumbers, DEFAULT_PREFERENCES.lineNumbers),
    rulerColumn: number(source.rulerColumn, DEFAULT_PREFERENCES.rulerColumn, 0, 200),
    fontLigatures: flag(source.fontLigatures, DEFAULT_PREFERENCES.fontLigatures),
    liveAnalysis: flag(source.liveAnalysis, DEFAULT_PREFERENCES.liveAnalysis),
    renderWhitespace: flag(source.renderWhitespace, DEFAULT_PREFERENCES.renderWhitespace),
    zenMode: flag(source.zenMode, DEFAULT_PREFERENCES.zenMode),
    wallSeconds: number(source.wallSeconds, DEFAULT_PREFERENCES.wallSeconds, 1, 120),
    memoryMb: number(source.memoryMb, DEFAULT_PREFERENCES.memoryMb, 16, 2048),
  };
}

export function loadPreferences(): Preferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalisePreferences(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(preferences: Preferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Private browsing or a full quota; the session still works.
  }
}

/** Apply a theme's tokens to the document root. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = theme.id;
}
