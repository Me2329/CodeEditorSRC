/**
 * The extension host.
 *
 * Owns the registry, decides when each extension wakes up, and keeps every
 * contribution attributable to the extension that made it so disabling one
 * removes exactly its own work and nothing else.
 *
 * Three rules the implementation is built around:
 *
 *   1. A failing extension is contained. `activate` runs inside a try/catch and
 *      a linter that throws is skipped for that file rather than blanking the
 *      diagnostics panel. One bad extension must not take the editor with it.
 *   2. Deactivation is complete. Contributions are indexed by extension id and
 *      removed wholesale, and the extension's own subscriptions are disposed.
 *      A plugin system that leaks on disable rots within a dozen toggles.
 *   3. Activation is lazy. Two hundred extensions cannot each run code at
 *      startup, and most are for languages the user is not writing right now.
 */

import type {
  ActivationEvent,
  CommandContribution,
  Disposable,
  EditorContext,
  EditorHost,
  Extension,
  ExtensionContext,
  ExtensionState,
  ExtensionStorage,
  FormatterContribution,
  LanguageConfiguration,
  LinterContribution,
  SnippetContribution,
  StatusBarContribution,
  TextActionContribution,
  ThemeContribution,
} from './types';
import type { Diagnostic, VirtualFile } from '../types';

const STORAGE_PREFIX = 'codecraft.extension.';
const DISABLED_KEY = 'codecraft.extensions.disabled';

/** A contribution with the extension that owns it, so removal is exact. */
interface Owned<T> {
  extensionId: string;
  value: T;
}

export class ExtensionHost {
  private readonly states = new Map<string, ExtensionState>();
  private readonly contexts = new Map<string, ExtensionContext>();

  private commands: Owned<CommandContribution>[] = [];
  private snippets: Owned<SnippetContribution>[] = [];
  private languages: Owned<LanguageConfiguration>[] = [];
  private linters: Owned<LinterContribution>[] = [];
  private formatters: Owned<FormatterContribution>[] = [];
  private statusBar: Owned<StatusBarContribution>[] = [];
  private textActions: Owned<TextActionContribution>[] = [];
  private themes: Owned<ThemeContribution>[] = [];

  private listeners = new Set<() => void>();
  /** Activation events already seen, so a late registration still activates. */
  private readonly firedEvents = new Set<string>();

  constructor(private host: EditorHost) {}

  /** Swap the host implementation, for tests and for React remounts. */
  setHost(host: EditorHost): void {
    this.host = host;
  }

  // ------------------------------------------------------------- observation

  /** Subscribe to registry changes so the interface can re-render. */
  subscribe(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  // -------------------------------------------------------------- lifecycle

  register(extension: Extension): void {
    const { id } = extension.manifest;
    if (this.states.has(id)) {
      // Re-registering would silently shadow the first one and leak its
      // contributions, so replace it properly instead.
      this.remove(id);
    }

    this.states.set(id, {
      extension,
      enabled: !readDisabled().has(id),
      activated: false,
      error: null,
    });

    const state = this.states.get(id)!;
    if (state.enabled) {
      this.applyContributions(extension);
      // An extension registered after startup still needs waking if the event
      // it waits for has already happened.
      void this.maybeActivate(id);
    }
    this.changed();
  }

  registerAll(extensions: readonly Extension[]): void {
    for (const extension of extensions) this.register(extension);
  }

  private remove(id: string): void {
    this.deactivate(id);
    this.removeContributions(id);
    this.states.delete(id);
  }

  list(): ExtensionState[] {
    return [...this.states.values()].sort((a, b) =>
      a.extension.manifest.name.localeCompare(b.extension.manifest.name),
    );
  }

  get(id: string): ExtensionState | undefined {
    return this.states.get(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    const state = this.states.get(id);
    if (!state || state.enabled === enabled) return;

    state.enabled = enabled;
    const disabled = readDisabled();
    if (enabled) {
      disabled.delete(id);
      state.error = null;
      this.applyContributions(state.extension);
      void this.maybeActivate(id);
    } else {
      disabled.add(id);
      this.deactivate(id);
      this.removeContributions(id);
    }
    writeDisabled(disabled);
    this.changed();
  }

  // ------------------------------------------------------------- activation

  /**
   * Report that something happened. Extensions waiting on it wake up.
   *
   * Events are remembered, so an extension registered after the event still
   * activates rather than waiting for it to happen again.
   */
  async fire(event: ActivationEvent): Promise<void> {
    this.firedEvents.add(event);
    const waiting = [...this.states.entries()].filter(
      ([, state]) =>
        state.enabled &&
        !state.activated &&
        (state.extension.manifest.activationEvents ?? ['onStartup']).includes(event),
    );
    for (const [id] of waiting) await this.activate(id);
  }

  private async maybeActivate(id: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) return;
    const events = state.extension.manifest.activationEvents ?? ['onStartup'];
    if (events.some((event) => this.firedEvents.has(event))) await this.activate(id);
  }

  private async activate(id: string): Promise<void> {
    const state = this.states.get(id);
    if (!state || state.activated || !state.enabled) return;

    state.activated = true;
    const { extension } = state;
    if (!extension.activate) return;

    const context: ExtensionContext = {
      manifest: extension.manifest,
      host: this.host,
      subscriptions: [],
      storage: createStorage(id),
    };
    this.contexts.set(id, context);

    try {
      await extension.activate(context);
      state.error = null;
    } catch (error) {
      // Contained: the extension is marked broken and its contributions are
      // withdrawn, but the editor carries on.
      state.error = error instanceof Error ? error.message : String(error);
      this.removeContributions(id);
      console.error(`extension ${id} failed to activate`, error);
    }
    this.changed();
  }

  private deactivate(id: string): void {
    const state = this.states.get(id);
    if (!state?.activated) return;

    try {
      state.extension.deactivate?.();
    } catch (error) {
      console.error(`extension ${id} failed to deactivate`, error);
    }

    const context = this.contexts.get(id);
    for (const subscription of context?.subscriptions ?? []) {
      try {
        subscription.dispose();
      } catch (error) {
        // Keep disposing the rest: one bad disposable must not strand the others.
        console.error(`extension ${id} disposable threw`, error);
      }
    }

    this.contexts.delete(id);
    state.activated = false;
  }

  // ----------------------------------------------------------- contributions

  private applyContributions(extension: Extension): void {
    const id = extension.manifest.id;
    const own = <T>(values: readonly T[] | undefined): Owned<T>[] =>
      (values ?? []).map((value) => ({ extensionId: id, value }));

    const contributes = extension.contributes ?? {};
    this.commands.push(...own(contributes.commands));
    this.snippets.push(...own(contributes.snippets));
    this.languages.push(...own(contributes.languages));
    this.linters.push(...own(contributes.linters));
    this.formatters.push(...own(contributes.formatters));
    this.statusBar.push(...own(contributes.statusBar));
    this.textActions.push(...own(contributes.textActions));
    this.themes.push(...own(contributes.themes));
  }

  private removeContributions(id: string): void {
    const without = <T>(list: Owned<T>[]) => list.filter((entry) => entry.extensionId !== id);
    this.commands = without(this.commands);
    this.snippets = without(this.snippets);
    this.languages = without(this.languages);
    this.linters = without(this.linters);
    this.formatters = without(this.formatters);
    this.statusBar = without(this.statusBar);
    this.textActions = without(this.textActions);
    this.themes = without(this.themes);
  }

  // ------------------------------------------------------------------ access

  allCommands(): CommandContribution[] {
    return this.commands.map((entry) => entry.value);
  }

  allTextActions(): TextActionContribution[] {
    return this.textActions.map((entry) => entry.value);
  }

  allThemes(): ThemeContribution[] {
    return this.themes.map((entry) => entry.value);
  }

  allStatusBar(): StatusBarContribution[] {
    return [...this.statusBar]
      .map((entry) => entry.value)
      .sort((a, b) => a.priority - b.priority);
  }

  /** Snippets for a language, plus the ones registered for every language. */
  snippetsFor(language: string): SnippetContribution[] {
    return this.snippets
      .map((entry) => entry.value)
      .filter((snippet) => snippet.language === language || snippet.language === '*');
  }

  languageConfiguration(language: string): LanguageConfiguration | null {
    return this.languages.find((entry) => entry.value.language === language)?.value ?? null;
  }

  formatterFor(language: string): FormatterContribution | null {
    return this.formatters.find((entry) => entry.value.language === language)?.value ?? null;
  }

  /**
   * Run every linter registered for the file's language.
   *
   * A linter that throws is skipped rather than losing the whole run: partial
   * diagnostics beat an empty panel and a stack trace.
   */
  lint(file: VirtualFile, language: string): Diagnostic[] {
    const found: Diagnostic[] = [];
    for (const entry of this.linters) {
      if (entry.value.language !== language && entry.value.language !== '*') continue;
      try {
        found.push(...entry.value.lint(file));
      } catch (error) {
        console.error(`linter ${entry.value.id} threw on ${file.name}`, error);
      }
    }
    return found;
  }

  /** Run a contributed command, activating its extension first if needed. */
  async runCommand(id: string, context: EditorContext): Promise<boolean> {
    await this.fire(`onCommand:${id}`);
    const command = this.commands.find((entry) => entry.value.id === id)?.value;
    if (!command) return false;
    try {
      await command.run(context);
    } catch (error) {
      console.error(`command ${id} failed`, error);
      this.host.notify(`Command failed: ${id}`, 'error');
    }
    return true;
  }
}

// ------------------------------------------------------------------ storage

function createStorage(id: string): ExtensionStorage {
  const key = (name: string) => `${STORAGE_PREFIX}${id}.${name}`;
  return {
    get<T>(name: string, fallback: T): T {
      try {
        const raw = localStorage.getItem(key(name));
        return raw === null ? fallback : (JSON.parse(raw) as T);
      } catch {
        // Private windows and cleared site data both land here.
        return fallback;
      }
    },
    set(name: string, value: unknown): void {
      try {
        localStorage.setItem(key(name), JSON.stringify(value));
      } catch {
        // Storage full or blocked; an extension preference is not worth throwing.
      }
    },
  };
}

function readDisabled(): Set<string> {
  try {
    const raw = localStorage.getItem(DISABLED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeDisabled(ids: Set<string>): void {
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify([...ids]));
  } catch {
    // Nothing to do; the preference simply will not survive a reload.
  }
}

/** A host that does nothing, for tests and for the first render. */
export const NOOP_HOST: EditorHost = {
  replaceActiveFile: () => {},
  insertAtCursor: () => {},
  openFile: () => {},
  createFile: () => {},
  runCommand: () => {},
  notify: () => {},
  setStatus: () => {},
};
