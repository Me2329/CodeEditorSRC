/**
 * What the window shows when a render throws.
 *
 * Without one of these, a single bad render unmounts everything and leaves a
 * blank page: no message, no editor, no way to tell a crash from a slow load.
 * That is not a hypothetical. A contributed theme with a dot in its name made
 * Monaco throw from inside an effect, and the whole application was a white
 * rectangle until someone opened the console.
 *
 * So the boundary does the two things a person in front of a blank editor
 * needs: it says what went wrong, and it offers the two ways out. Reloading is
 * the first, because most render failures do not survive a remount. Clearing
 * stored state is the second, and it is deliberately the smaller button: the
 * workspace lives in local storage, so it is also the button that throws work
 * away.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Everything this editor keeps in local storage.
 *
 * Listed here rather than reached for through each module's private constant,
 * because the one screen that needs all of them at once is this one: the escape
 * hatch from a render that fails on stored state. A test reads the modules and
 * fails if one of them starts storing something this list does not know about,
 * since a hatch that clears three of four keys is not a hatch.
 *
 * The extension entries are a prefix rather than a key: every enabled extension
 * has its own, and an extension that stored something it cannot read back is
 * exactly the kind of thing to clear here.
 */
export const STORED_KEYS = [
  'codecraft.workspace.v1',
  'codecraft.history.v1',
  'codecraft.session.v1',
  'codecraft.preferences.v1',
  'codecraft.extensions.disabled',
] as const;

export const STORED_PREFIXES = ['codecraft.extension.'] as const;

interface Props {
  children: ReactNode;
  /** Storage keys to remove when someone asks for a clean start. */
  storageKeys?: readonly string[];
  /** And every key beginning with one of these. */
  storagePrefixes?: readonly string[];
}

interface State {
  error: Error | null;
  /** Where React said the error came from, when it said. */
  where: string;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, where: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept for the person reading the console, which is where a stack belongs.
    console.error('CodeCraft Studio stopped rendering', error, info.componentStack);
    this.setState({ where: (info.componentStack ?? '').trim().split('\n')[0]?.trim() ?? '' });
  }

  private reload = (): void => {
    window.location.reload();
  };

  private clearAndReload = (): void => {
    try {
      for (const key of this.props.storageKeys ?? []) {
        window.localStorage.removeItem(key);
      }
      for (const key of Object.keys(window.localStorage)) {
        if ((this.props.storagePrefixes ?? []).some((prefix) => key.startsWith(prefix))) {
          window.localStorage.removeItem(key);
        }
      }
    } catch {
      // A browser that will not let go of storage is not a reason to stay on
      // this screen; the reload is still worth trying.
    }
    window.location.reload();
  };

  override render(): ReactNode {
    const { error, where } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full min-h-screen items-center justify-center bg-obsidian p-8">
        <div className="max-w-xl space-y-4">
          <h1 className="text-lg font-semibold text-slate-100">
            CodeCraft Studio stopped rendering
          </h1>
          <p className="text-sm leading-relaxed text-slate-400">
            Something threw while drawing the editor. Your files are stored in this
            browser and are almost certainly still there; reloading is the first thing
            to try.
          </p>
          <pre className="overflow-x-auto rounded border border-slate-800 bg-panel p-3 font-mono text-[11px] text-halt">
            {error.message || String(error)}
            {where ? `\n  in ${where}` : ''}
          </pre>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={this.reload}
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={this.clearAndReload}
              className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
            >
              Clear stored state and reload
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-slate-600">
            Clearing stored state discards the workspace, its history and your
            preferences. Use it only when reloading lands here again.
          </p>
        </div>
      </div>
    );
  }
}
