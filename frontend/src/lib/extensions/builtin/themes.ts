/**
 * Editor colour schemes, contributed rather than built in.
 *
 * The five themes in settings colour the whole interface: the panels, the
 * terminal and the editor together. These colour the editor alone, which is
 * what a theme contribution can reach, and they exist because the contribution
 * point had a type, a host accessor and nothing behind either.
 *
 * Monaco's `base` decides everything not named here, so each of these is a
 * short list of overrides on top of a dark or light foundation rather than a
 * complete scheme. That is also why they are honest about what they are: a
 * theme that had to name every token colour would be a thousand lines and
 * would still miss the ones Monaco adds next release.
 */

import type { Extension, ThemeContribution } from '../types';

export const midnight: ThemeContribution = {
  id: 'codecraft.midnight',
  label: 'Midnight',
  base: 'vs-dark',
  colors: {
    'editor.background': '#0b0f19',
    'editor.foreground': '#cbd5e1',
    'editorLineNumber.foreground': '#334155',
    'editorLineNumber.activeForeground': '#818cf8',
    'editor.selectionBackground': '#1e293b',
    'editor.lineHighlightBackground': '#111827',
    'editorCursor.foreground': '#a78bfa',
    'editorIndentGuide.background1': '#1e293b',
  },
};

export const parchment: ThemeContribution = {
  id: 'codecraft.parchment',
  label: 'Parchment',
  base: 'vs',
  colors: {
    'editor.background': '#faf6ef',
    'editor.foreground': '#3b3228',
    'editorLineNumber.foreground': '#b9ab96',
    'editorLineNumber.activeForeground': '#7c6f57',
    'editor.selectionBackground': '#e8dcc6',
    'editor.lineHighlightBackground': '#f2ebdd',
    'editorCursor.foreground': '#8a6d3b',
  },
};

export const ember: ThemeContribution = {
  id: 'codecraft.ember',
  label: 'Ember',
  base: 'vs-dark',
  colors: {
    'editor.background': '#15100f',
    'editor.foreground': '#e7d7c9',
    'editorLineNumber.foreground': '#4a3a33',
    'editorLineNumber.activeForeground': '#e0813a',
    'editor.selectionBackground': '#3a2620',
    'editor.lineHighlightBackground': '#1e1614',
    'editorCursor.foreground': '#e0813a',
  },
};

export const THEMES: ThemeContribution[] = [midnight, parchment, ember];

export const themePack: Extension = {
  manifest: {
    id: 'codecraft.themes',
    name: 'Editor Themes',
    description:
      'Three colour schemes for the editor surface: Midnight, Parchment and Ember. The interface keeps the theme chosen in settings.',
    version: '1.0.0',
    publisher: 'codecraft',
    icon: '🎨',
    categories: ['Themes'],
    activationEvents: ['onStartup'],
  },
  contributes: { themes: THEMES },
};
