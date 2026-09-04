import { describe, expect, it } from 'vitest';

import { createFile, loadWorkspace, monacoLanguageFor, saveWorkspace, validateFileName } from './vfs';

describe('monacoLanguageFor', () => {
  it('maps known extensions to Monaco language ids', () => {
    expect(monacoLanguageFor('main.rs')).toBe('rust');
    expect(monacoLanguageFor('main.cpp')).toBe('cpp');
    expect(monacoLanguageFor('script.sh')).toBe('shell');
    expect(monacoLanguageFor('Cargo.toml')).toBe('ini');
  });

  it('falls back to plaintext for unknown or missing extensions', () => {
    expect(monacoLanguageFor('Makefile')).toBe('plaintext');
    expect(monacoLanguageFor('archive.qqq')).toBe('plaintext');
    expect(monacoLanguageFor('trailing.')).toBe('plaintext');
  });
});

describe('validateFileName', () => {
  const existing = [createFile('main.py', '')];

  it('accepts ordinary relative paths', () => {
    expect(validateFileName('util.py', existing)).toBeNull();
    expect(validateFileName('pkg/util.py', existing)).toBeNull();
  });

  it('rejects names that escape the workspace', () => {
    for (const name of ['../evil.py', 'a/../../b.py', '/etc/passwd', '~/x.py', 'a//b.py', '..']) {
      expect(validateFileName(name, existing)).not.toBeNull();
    }
  });

  it('rejects empty names and duplicates', () => {
    expect(validateFileName('   ', existing)).not.toBeNull();
    expect(validateFileName('main.py', existing)).toContain('already exists');
  });

  it('rejects backslashes and control characters', () => {
    expect(validateFileName('a\\b.py', existing)).not.toBeNull();
    expect(validateFileName(`a${String.fromCharCode(10)}b.py`, existing)).not.toBeNull();
    expect(validateFileName(`a${String.fromCharCode(0)}b.py`, existing)).not.toBeNull();
  });
});

describe('createFile', () => {
  it('assigns a unique id and derives the language', () => {
    const a = createFile('main.go', 'package main');
    const b = createFile('main.go', 'package main');
    expect(a.id).not.toBe(b.id);
    expect(a.language).toBe('go');
  });
});

describe('workspace persistence', () => {
  it('round-trips a saved workspace', () => {
    const files = [createFile('main.py', 'print(1)')];
    saveWorkspace({ language: 'python', files, activeFileId: files[0]!.id });

    const restored = loadWorkspace();
    expect(restored?.language).toBe('python');
    expect(restored?.files[0]?.content).toBe('print(1)');
  });

  it('discards a malformed or empty payload rather than crashing', () => {
    window.localStorage.setItem('codecraft.workspace.v1', '{ not json');
    expect(loadWorkspace()).toBeNull();

    window.localStorage.setItem('codecraft.workspace.v1', JSON.stringify({ language: 'python', files: [] }));
    expect(loadWorkspace()).toBeNull();
  });
});
