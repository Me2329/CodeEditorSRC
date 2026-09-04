/**
 * In-memory virtual file system.
 *
 * The workspace is plain data so it can be serialised into an execution request
 * and restored from local storage without a separate persistence layer.
 */

import type { VirtualFile } from './types';

/** Maps a file extension onto Monaco's language id. */
const EXTENSION_TO_MONACO: Record<string, string> = {
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  rs: 'rust',
  go: 'go',
  py: 'python',
  rb: 'ruby',
  php: 'php',
  pl: 'perl',
  lua: 'lua',
  java: 'java',
  kt: 'kotlin',
  scala: 'scala',
  swift: 'swift',
  dart: 'dart',
  cs: 'csharp',
  fsx: 'fsharp',
  exs: 'elixir',
  clj: 'clojure',
  groovy: 'groovy',
  hs: 'haskell',
  jl: 'julia',
  R: 'r',
  rkt: 'scheme',
  erl: 'erlang',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  ps1: 'powershell',
  sql: 'sql',
  html: 'html', htm: 'html',
  css: 'css',
  json: 'json',
  toml: 'ini',
  yaml: 'yaml', yml: 'yaml',
  md: 'markdown',
  zig: 'zig',
  d: 'd',
  nim: 'plaintext',
  f90: 'plaintext',
  asm: 'plaintext',
  wat: 'plaintext',
  awk: 'plaintext',
  jq: 'plaintext',
};

export function monacoLanguageFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1 || dot === fileName.length - 1) return 'plaintext';
  const extension = fileName.slice(dot + 1);
  return EXTENSION_TO_MONACO[extension] ?? 'plaintext';
}

let counter = 0;

export function createFile(name: string, content: string): VirtualFile {
  counter += 1;
  return {
    id: `f${Date.now().toString(36)}${counter.toString(36)}`,
    name,
    language: monacoLanguageFor(name),
    content,
  };
}

/**
 * Control characters are rejected in file names. The pattern is built from a
 * string so this source file contains no literal control bytes of its own.
 */
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001f\\u007f]');

/**
 * Validate a workspace-relative file name using the same rule the gateway and
 * the supervisor apply, so the editor rejects a bad name before a round trip.
 */
export function validateFileName(name: string, existing: readonly VirtualFile[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Name cannot be empty.';
  if (trimmed.length > 255) return 'Name must be 255 characters or fewer.';
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) {
    return 'Name must be relative to the workspace.';
  }
  if (trimmed.includes('\\')) return 'Use forward slashes, not backslashes.';
  if (CONTROL_CHARACTERS.test(trimmed)) return 'Name cannot contain control characters.';
  for (const part of trimmed.split('/')) {
    if (!part) return 'Name cannot contain an empty path segment.';
    if (part === '.' || part === '..') return 'Name cannot escape the workspace.';
  }
  if (existing.some((file) => file.name === trimmed)) {
    return `"${trimmed}" already exists in this workspace.`;
  }
  return null;
}

const STORAGE_KEY = 'codecraft.workspace.v1';

export interface PersistedWorkspace {
  language: string;
  files: VirtualFile[];
  activeFileId: string;
}

export function saveWorkspace(state: PersistedWorkspace): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private browsing or a full quota; losing the draft is not worth an error.
  }
}

export function loadWorkspace(): PersistedWorkspace | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWorkspace;
    if (
      typeof parsed?.language !== 'string' ||
      !Array.isArray(parsed.files) ||
      parsed.files.length === 0 ||
      !parsed.files.every(
        (file) => typeof file?.name === 'string' && typeof file?.content === 'string',
      )
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
