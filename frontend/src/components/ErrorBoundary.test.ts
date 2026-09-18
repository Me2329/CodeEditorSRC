import { describe, expect, it } from 'vitest';

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ErrorBoundary, STORED_KEYS, STORED_PREFIXES } from './ErrorBoundary';

describe('the error boundary', () => {
  it('shows the error it was given rather than a blank page', () => {
    const failure = new Error('Illegal theme name!');
    expect(ErrorBoundary.getDerivedStateFromError(failure)).toEqual({ error: failure });
  });

  it('knows every key the editor stores', () => {
    // The escape hatch is only an escape if it clears all of them: a render
    // that fails on the stored session is not helped by dropping the files.
    // Read from the modules rather than listed twice, so a new one cannot be
    // added without this failing.
    const sources = ['src/lib', 'src/lib/extensions'].flatMap((directory) =>
      readdirSync(directory)
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => readFileSync(join(directory, name), 'utf8')),
    );

    const stored = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/=\s*'(codecraft\.[A-Za-z0-9_.]+)'/g)) {
        if (match[1]) stored.add(match[1]);
      }
    }

    expect(stored.size).toBeGreaterThan(0);
    for (const key of stored) {
      const covered =
        STORED_KEYS.includes(key as (typeof STORED_KEYS)[number]) ||
        STORED_PREFIXES.some((prefix) => key.startsWith(prefix));
      expect(covered, `${key} is stored but the boundary would not clear it`).toBe(true);
    }
  });
});
