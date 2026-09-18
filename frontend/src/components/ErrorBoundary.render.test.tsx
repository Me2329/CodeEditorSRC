/**
 * The boundary, rendered for real.
 *
 * The static half can be checked by calling it; the half that matters is
 * whether a child throwing puts a message on the screen instead of leaving an
 * empty document, and the only way to know that is to mount it.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('Illegal theme name!');
}

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  // React logs the error it caught, which is right, and would otherwise make
  // the test output look like a failure.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
});

describe('a child that throws', () => {
  it('leaves a message on the screen rather than an empty page', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
    });

    expect(container.textContent).toContain('stopped rendering');
    expect(container.textContent).toContain('Illegal theme name!');
    expect(container.textContent).toContain('Reload');
  });

  it('clears only the keys it was given, and only when asked', async () => {
    localStorage.setItem('codecraft.workspace.v1', 'x');
    localStorage.setItem('codecraft.extension.alpha', 'x');
    localStorage.setItem('unrelated', 'keep me');
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      reload,
    } as unknown as Location);

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ErrorBoundary
          storageKeys={['codecraft.workspace.v1']}
          storagePrefixes={['codecraft.extension.']}
        >
          <Boom />
        </ErrorBoundary>,
      );
    });

    expect(localStorage.getItem('codecraft.workspace.v1')).toBe('x');

    const buttons = [...container.querySelectorAll('button')];
    const clear = buttons.find((button) => button.textContent?.includes('Clear'));
    await act(async () => {
      clear?.click();
    });

    expect(localStorage.getItem('codecraft.workspace.v1')).toBeNull();
    expect(localStorage.getItem('codecraft.extension.alpha')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('keep me');
    expect(reload).toHaveBeenCalled();
  });

  it('renders its children when nothing throws', async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ErrorBoundary>
          <p>the editor</p>
        </ErrorBoundary>,
      );
    });

    expect(container.textContent).toBe('the editor');
  });
});
