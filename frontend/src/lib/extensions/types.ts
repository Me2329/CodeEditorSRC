/**
 * The extension contract.
 *
 * An extension is a manifest plus an activate function. It declares what it
 * contributes and when it should wake up; the host does the rest. Nothing here
 * imports React or Monaco, so an extension can be written, reasoned about and
 * tested without the editor running.
 *
 * The design constraint that shapes everything below: an extension must not be
 * able to break the editor. Every contribution is registered through the host
 * rather than by mutating shared state, every activation is wrapped, and every
 * registration returns a Disposable so deactivating an extension removes every
 * trace of it. Extensions that half-uninstall are the reason plugin systems rot.
 */

import type { Diagnostic, VirtualFile } from '../types';

/** Something that can be undone. Every registration returns one. */
export interface Disposable {
  dispose(): void;
}

/**
 * When an extension should be activated.
 *
 * Lazy activation is the point: an editor with two hundred extensions cannot
 * afford to run two hundred activate functions at startup, and most of them are
 * for languages the user is not currently writing.
 */
export type ActivationEvent =
  | 'onStartup'
  /** The user opened a file of this language, e.g. `onLanguage:python`. */
  | `onLanguage:${string}`
  /** A command this extension contributes was invoked. */
  | `onCommand:${string}`
  /** A file matching this glob appeared in the workspace. */
  | `onFile:${string}`;

export interface ExtensionManifest {
  /** Unique, stable, namespaced: `publisher.name`. */
  id: string;
  name: string;
  description: string;
  version: string;
  publisher: string;
  /** Shown in the extensions list. One or two emoji. */
  icon?: string;
  categories?: readonly string[];
  activationEvents?: readonly ActivationEvent[];
}

// ---------------------------------------------------------------- contributions

export interface CommandContribution {
  id: string;
  title: string;
  category: string;
  /** Display only; the host does not bind keys on the extension's behalf. */
  shortcut?: string;
  run(context: EditorContext): void | Promise<void>;
}

export interface SnippetContribution {
  /** Language id this snippet applies to, or `*` for all. */
  language: string;
  prefix: string;
  description: string;
  /** `$0` marks where the caret lands, `$1`, `$2` are tab stops. */
  body: string;
}

export interface LanguageConfiguration {
  language: string;
  lineComment?: string;
  blockComment?: readonly [string, string];
  /** Pairs auto-closed as you type and surrounded on selection. */
  brackets?: readonly (readonly [string, string])[];
  indentAfter?: RegExp;
  dedentBefore?: RegExp;
}

/**
 * A source of diagnostics beyond the C++ analyzer.
 *
 * Runs on the client against file text, so it must be fast and pure. Anything
 * needing real compilation belongs in the analyzer or a sandboxed run.
 */
export interface LinterContribution {
  id: string;
  language: string;
  lint(file: VirtualFile): Diagnostic[];
}

export interface FormatterContribution {
  id: string;
  language: string;
  format(text: string, options: FormatOptions): string;
}

export interface FormatOptions {
  tabSize: number;
  insertSpaces: boolean;
}

export interface StatusBarContribution {
  id: string;
  /** Lower numbers sit further left. */
  priority: number;
  alignment: 'left' | 'right';
  render(context: EditorContext): StatusBarItem | null;
}

export interface StatusBarItem {
  text: string;
  tooltip?: string;
  /** Command id to run when clicked. */
  command?: string;
  tone?: 'normal' | 'accent' | 'warning' | 'danger';
}

/** A named, reusable transformation of the selected text or whole file. */
export interface TextActionContribution {
  id: string;
  title: string;
  category: string;
  /** Applied to the selection when there is one, otherwise the whole file. */
  transform(text: string): string;
}

/**
 * Something to say about the word under the pointer.
 *
 * Given the word and the line it sits on, because a word alone is often not
 * enough to know what it is: `class` in a comment is prose, and a hover that
 * fires there is noise.
 *
 * Returning null is the common case and costs nothing.
 */
export interface HoverContribution {
  id: string;
  /** A language id, or `*` for every language. */
  language: string;
  hover(word: string, line: string): HoverText | null;
}

export interface HoverText {
  /** A short title, shown in bold. */
  title: string;
  /** One or two sentences. Markdown, rendered by the editor. */
  body: string;
}

export interface ThemeContribution {
  id: string;
  label: string;
  base: 'vs' | 'vs-dark' | 'hc-black';
  colors: Record<string, string>;
}

export interface ExtensionContributions {
  commands?: readonly CommandContribution[];
  snippets?: readonly SnippetContribution[];
  languages?: readonly LanguageConfiguration[];
  linters?: readonly LinterContribution[];
  formatters?: readonly FormatterContribution[];
  statusBar?: readonly StatusBarContribution[];
  textActions?: readonly TextActionContribution[];
  themes?: readonly ThemeContribution[];
  hovers?: readonly HoverContribution[];
}

// ------------------------------------------------------------------- runtime

/**
 * What an extension can see about the editor.
 *
 * Deliberately a snapshot rather than live objects: an extension cannot hold a
 * reference to editor internals and poke at them later.
 */
export interface EditorContext {
  readonly files: readonly VirtualFile[];
  readonly activeFile: VirtualFile | null;
  readonly language: string;
  readonly selection: string;
  readonly line: number;
  readonly column: number;
}

/**
 * What an extension can do to the editor.
 *
 * Every method is a request the host fulfils, so the host can refuse, log, or
 * undo any of them.
 */
export interface EditorHost {
  /** Replace the active file's contents as one undoable edit. */
  replaceActiveFile(content: string): void;
  /** Insert at the caret. */
  insertAtCursor(text: string): void;
  openFile(name: string): void;
  createFile(name: string, content: string): void;
  runCommand(id: string): void;
  notify(message: string, tone?: 'info' | 'warning' | 'error'): void;
  setStatus(message: string): void;
}

/** Handed to `activate`. Registrations made through it are tracked. */
export interface ExtensionContext {
  readonly manifest: ExtensionManifest;
  readonly host: EditorHost;
  /**
   * Disposables added here are disposed when the extension deactivates. The
   * host also disposes contributions it registered itself, so an extension only
   * needs this for resources it created (timers, listeners).
   */
  readonly subscriptions: Disposable[];
  /** Per-extension key/value storage, persisted in local storage. */
  readonly storage: ExtensionStorage;
}

export interface ExtensionStorage {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

export interface Extension {
  manifest: ExtensionManifest;
  contributes?: ExtensionContributions;
  /** Optional: most extensions are pure contributions and need no code. */
  activate?(context: ExtensionContext): void | Promise<void>;
  deactivate?(): void;
}

export interface ExtensionState {
  extension: Extension;
  enabled: boolean;
  activated: boolean;
  /** Set when activation threw, so the interface can show why. */
  error: string | null;
}
