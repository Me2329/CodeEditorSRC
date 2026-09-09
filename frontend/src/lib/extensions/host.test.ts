import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ExtensionHost, NOOP_HOST } from './host';
import type { EditorContext, Extension } from './types';
import { BUILTIN_EXTENSIONS } from './builtin';

const CONTEXT: EditorContext = {
  files: [],
  activeFile: null,
  language: 'python',
  selection: '',
  line: 1,
  column: 1,
};

function makeExtension(id: string, overrides: Partial<Extension> = {}): Extension {
  return {
    manifest: {
      id,
      name: id,
      description: '',
      version: '1.0.0',
      publisher: 'test',
      activationEvents: ['onStartup'],
    },
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('registration', () => {
  test('an extension appears in the list once registered', () => {
    const host = new ExtensionHost(NOOP_HOST);
    host.register(makeExtension('test.one'));

    expect(host.list().map((state) => state.extension.manifest.id)).toEqual(['test.one']);
  });

  test('contributions become available immediately', () => {
    const host = new ExtensionHost(NOOP_HOST);
    host.register(
      makeExtension('test.one', {
        contributes: {
          textActions: [
            { id: 'a', title: 'A', category: 'Test', transform: (text) => text.toUpperCase() },
          ],
        },
      }),
    );

    expect(host.allTextActions()).toHaveLength(1);
  });

  test('registering the same id twice replaces rather than duplicates', () => {
    const host = new ExtensionHost(NOOP_HOST);
    const contributes = {
      textActions: [{ id: 'a', title: 'A', category: 'T', transform: (text: string) => text }],
    };

    host.register(makeExtension('test.one', { contributes }));
    host.register(makeExtension('test.one', { contributes }));

    expect(host.list()).toHaveLength(1);
    // The first registration's contributions must not have been left behind.
    expect(host.allTextActions()).toHaveLength(1);
  });

  test('subscribers are notified when the registry changes', () => {
    const host = new ExtensionHost(NOOP_HOST);
    const listener = vi.fn();
    host.subscribe(listener);

    host.register(makeExtension('test.one'));

    expect(listener).toHaveBeenCalled();
  });

  test('an unsubscribed listener stops being called', () => {
    const host = new ExtensionHost(NOOP_HOST);
    const listener = vi.fn();
    host.subscribe(listener).dispose();

    host.register(makeExtension('test.one'));

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('enabling and disabling', () => {
  test('disabling withdraws every contribution the extension made', () => {
    const host = new ExtensionHost(NOOP_HOST);
    host.register(
      makeExtension('test.one', {
        contributes: {
          textActions: [{ id: 'a', title: 'A', category: 'T', transform: (text) => text }],
          snippets: [{ language: 'python', prefix: 'p', description: '', body: '' }],
          themes: [{ id: 't', label: 'T', base: 'vs-dark', colors: {} }],
        },
      }),
    );

    host.setEnabled('test.one', false);

    expect(host.allTextActions()).toHaveLength(0);
    expect(host.snippetsFor('python')).toHaveLength(0);
    expect(host.allThemes()).toHaveLength(0);
  });

  test('disabling one extension leaves the others untouched', () => {
    const host = new ExtensionHost(NOOP_HOST);
    const action = (id: string) => ({
      textActions: [{ id, title: id, category: 'T', transform: (text: string) => text }],
    });

    host.register(makeExtension('test.one', { contributes: action('a') }));
    host.register(makeExtension('test.two', { contributes: action('b') }));
    host.setEnabled('test.one', false);

    expect(host.allTextActions().map((entry) => entry.id)).toEqual(['b']);
  });

  test('re-enabling restores the contributions', () => {
    const host = new ExtensionHost(NOOP_HOST);
    host.register(
      makeExtension('test.one', {
        contributes: {
          textActions: [{ id: 'a', title: 'A', category: 'T', transform: (text) => text }],
        },
      }),
    );

    host.setEnabled('test.one', false);
    host.setEnabled('test.one', true);

    expect(host.allTextActions()).toHaveLength(1);
  });

  test('enabling twice does not register the contributions twice', () => {
    const host = new ExtensionHost(NOOP_HOST);
    host.register(
      makeExtension('test.one', {
        contributes: {
          textActions: [{ id: 'a', title: 'A', category: 'T', transform: (text) => text }],
        },
      }),
    );

    host.setEnabled('test.one', true);

    expect(host.allTextActions()).toHaveLength(1);
  });

  test('a disabled extension stays disabled across a restart', () => {
    const first = new ExtensionHost(NOOP_HOST);
    first.register(makeExtension('test.one'));
    first.setEnabled('test.one', false);

    const second = new ExtensionHost(NOOP_HOST);
    second.register(makeExtension('test.one'));

    expect(second.get('test.one')?.enabled).toBe(false);
  });
});

describe('activation', () => {
  test('an extension does not activate before its event fires', async () => {
    const activate = vi.fn();
    const host = new ExtensionHost(NOOP_HOST);
    host.register(
      makeExtension('test.one', {
        manifest: {
          id: 'test.one',
          name: 'one',
          description: '',
          version: '1',
          publisher: 't',
          activationEvents: ['onLanguage:rust'],
        },
        activate,
      }),
    );

    expect(activate).not.toHaveBeenCalled();
    await host.fire('onLanguage:rust');
    expect(activate).toHaveBeenCalledOnce();
  });

  test('activation happens once however many times the event fires', async () => {
    const activate = vi.fn();
    const host = new ExtensionHost(NOOP_HOST);
    host.register(makeExtension('test.one', { activate }));

    await host.fire('onStartup');
    await host.fire('onStartup');

    expect(activate).toHaveBeenCalledOnce();
  });

  test('an extension registered after its event still activates', async () => {
    const host = new ExtensionHost(NOOP_HOST);
    await host.fire('onStartup');

    const activate = vi.fn();
    host.register(makeExtension('test.late', { activate }));
    // Registration is synchronous but activation is not, so let it settle.
    await Promise.resolve();

    expect(activate).toHaveBeenCalledOnce();
  });

  test('a disabled extension is never activated', async () => {
    const host = new ExtensionHost(NOOP_HOST);
    const activate = vi.fn();
    host.register(makeExtension('test.one', { activate }));
    host.setEnabled('test.one', false);

    await host.fire('onStartup');

    expect(activate).not.toHaveBeenCalled();
  });
});

describe('containment', () => {
  test('an extension that throws on activation does not break the host', async () => {
    const host = new ExtensionHost(NOOP_HOST);
    host.register(
      makeExtension('test.bad', {
        activate: () => {
          throw new Error('deliberate');
        },
      }),
    );
    host.register(makeExtension('test.good'));

    await expect(host.fire('onStartup')).resolves.toBeUndefined();
    expect(host.get('test.bad')?.error).toBe('deliberate');
    expect(host.get('test.good')?.error).toBeNull();
  });

  test('a broken extension has its contributions withdrawn', async () => {
    const host = new ExtensionHost(NOOP_HOST);
    host.register(
      makeExtension('test.bad', {
        contributes: {
          textActions: [{ id: 'a', title: 'A', category: 'T', transform: (text) => text }],
        },
        activate: () => {
          throw new Error('deliberate');
        },
      }),
    );

    await host.fire('onStartup');

    expect(host.allTextActions()).toHaveLength(0);
  });

  test('a linter that throws is skipped without losing the others', () => {
    const host = new ExtensionHost(NOOP_HOST);
    host.register(
      makeExtension('test.bad', {
        contributes: {
          linters: [
            {
              id: 'bad',
              language: 'python',
              lint: () => {
                throw new Error('deliberate');
              },
            },
          ],
        },
      }),
    );
    host.register(
      makeExtension('test.good', {
        contributes: {
          linters: [
            {
              id: 'good',
              language: 'python',
              lint: () => [
                { line: 1, column: 1, severity: 'warning' as const, message: 'found', rule: 'r' },
              ],
            },
          ],
        },
      }),
    );

    const found = host.lint({ id: '1', name: 'a.py', content: 'x = 1', language: 'python' }, 'python');

    expect(found).toHaveLength(1);
    expect(found[0]?.message).toBe('found');
  });

  test('a command that throws is reported rather than propagated', async () => {
    const notify = vi.fn();
    const host = new ExtensionHost({ ...NOOP_HOST, notify });
    host.register(
      makeExtension('test.one', {
        contributes: {
          commands: [
            {
              id: 'boom',
              title: 'Boom',
              category: 'T',
              run: () => {
                throw new Error('deliberate');
              },
            },
          ],
        },
      }),
    );

    await expect(host.runCommand('boom', CONTEXT)).resolves.toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('boom'), 'error');
  });
});

describe('deactivation', () => {
  test('deactivate is called and subscriptions are disposed', () => {
    const deactivate = vi.fn();
    const dispose = vi.fn();
    const host = new ExtensionHost(NOOP_HOST);

    host.register(
      makeExtension('test.one', {
        activate: (context) => {
          context.subscriptions.push({ dispose });
        },
        deactivate,
      }),
    );

    return host.fire('onStartup').then(() => {
      host.setEnabled('test.one', false);
      expect(deactivate).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
    });
  });

  test('one disposable that throws does not strand the rest', async () => {
    const second = vi.fn();
    const host = new ExtensionHost(NOOP_HOST);

    host.register(
      makeExtension('test.one', {
        activate: (context) => {
          context.subscriptions.push({
            dispose: () => {
              throw new Error('deliberate');
            },
          });
          context.subscriptions.push({ dispose: second });
        },
      }),
    );
    await host.fire('onStartup');

    host.setEnabled('test.one', false);

    expect(second).toHaveBeenCalledOnce();
  });

  test('an extension can be activated again after being disabled', async () => {
    const activate = vi.fn();
    const host = new ExtensionHost(NOOP_HOST);
    host.register(makeExtension('test.one', { activate }));
    await host.fire('onStartup');

    host.setEnabled('test.one', false);
    host.setEnabled('test.one', true);
    await Promise.resolve();

    expect(activate).toHaveBeenCalledTimes(2);
  });
});

describe('lookup', () => {
  test('snippets registered for every language are offered alongside the specific ones', () => {
    const host = new ExtensionHost(NOOP_HOST);
    host.register(
      makeExtension('test.one', {
        contributes: {
          snippets: [
            { language: 'python', prefix: 'p', description: '', body: '' },
            { language: '*', prefix: 'u', description: '', body: '' },
            { language: 'rust', prefix: 'r', description: '', body: '' },
          ],
        },
      }),
    );

    expect(host.snippetsFor('python').map((entry) => entry.prefix)).toEqual(['p', 'u']);
  });

  test('status bar items are ordered by priority', () => {
    const host = new ExtensionHost(NOOP_HOST);
    const item = (id: string, priority: number) => ({
      id,
      priority,
      alignment: 'right' as const,
      render: () => ({ text: id }),
    });

    host.register(makeExtension('test.one', { contributes: { statusBar: [item('b', 20)] } }));
    host.register(makeExtension('test.two', { contributes: { statusBar: [item('a', 10)] } }));

    expect(host.allStatusBar().map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  test('an unknown command reports that it was not found', async () => {
    const host = new ExtensionHost(NOOP_HOST);
    expect(await host.runCommand('nothing.here', CONTEXT)).toBe(false);
  });

  test('storage is namespaced per extension', async () => {
    const host = new ExtensionHost(NOOP_HOST);
    host.register(
      makeExtension('test.one', {
        activate: (context) => context.storage.set('key', 'from-one'),
      }),
    );
    host.register(
      makeExtension('test.two', {
        activate: (context) => {
          expect(context.storage.get('key', 'default')).toBe('default');
        },
      }),
    );

    await host.fire('onStartup');
  });
});

describe('the bundled extensions', () => {
  test('all of them register and activate cleanly', async () => {
    const host = new ExtensionHost(NOOP_HOST);
    host.registerAll(BUILTIN_EXTENSIONS);
    await host.fire('onStartup');

    expect(host.list()).toHaveLength(BUILTIN_EXTENSIONS.length);
    expect(host.list().filter((state) => state.error !== null)).toEqual([]);
  });

  test('every bundled extension has a unique id', () => {
    const ids = BUILTIN_EXTENSIONS.map((extension) => extension.manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('they contribute a substantial number of actions', () => {
    const host = new ExtensionHost(NOOP_HOST);
    host.registerAll(BUILTIN_EXTENSIONS);

    expect(host.allTextActions().length).toBeGreaterThanOrEqual(30);
    expect(host.snippetsFor('python').length).toBeGreaterThanOrEqual(10);
  });

  test('disabling every one of them leaves nothing behind', () => {
    const host = new ExtensionHost(NOOP_HOST);
    host.registerAll(BUILTIN_EXTENSIONS);
    for (const extension of BUILTIN_EXTENSIONS) host.setEnabled(extension.manifest.id, false);

    expect(host.allTextActions()).toEqual([]);
    expect(host.allStatusBar()).toEqual([]);
    expect(host.snippetsFor('python')).toEqual([]);
    expect(host.lint({ id: '1', name: 'a.py', content: 'x=1\n', language: 'python' }, 'python')).toEqual([]);
  });
});
