/**
 * The CodeCraft Studio workspace.
 *
 * Owns the virtual file system, the runtime selection and the run lifecycle,
 * and wires them to the editor, the console, the preview and the analysis
 * panel.
 */

import Editor, { type OnMount } from '@monaco-editor/react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Code2,
  Cpu,
  Download,
  GitCompare,
  History as HistoryIcon,
  Loader2,
  Maximize2,
  Package,
  Play,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Zap,
  Upload,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useExecutionSocket, type RunOutcome } from '../hooks/useExecutionSocket';
import { editorContextFrom, useExtensions } from '../hooks/useExtensions';
import {
  declarationsOf,
  definitionFrom,
  describeDeclarations,
  wordAt,
} from '../lib/definitions';
import { contextAround, shouldRequest, tidy, worthShowing } from '../lib/inline';
import {
  order as byRecency,
  previous as previousFile,
  prune as pruneRecent,
  touch as touchRecent,
} from '../lib/recent';
import {
  decide as decideDropped,
  explain as explainRefused,
  read as readDropped,
  uniqueName,
} from '../lib/drop';
import { nextAfter, position as problemPosition, previousBefore } from '../lib/problems';
import { loadSession, reconcile, saveSession } from '../lib/session';
import { outstanding, scanWorkspace } from '../lib/todos';
import { zipFiles } from '../lib/zip';
import type { SnippetContribution } from '../lib/extensions/types';
import { matching as matchingSnippets, reindent } from '../lib/snippets';
import { DEFAULT_BINDINGS, merge as mergeBindings, resolve as resolveBinding } from '../lib/keybindings';
import {
  EMPTY as NO_PLACES,
  back as goBack,
  canGoBack,
  canGoForward,
  current as currentPlace,
  forget as forgetPlaces,
  forward as goForward,
  visit as visitPlace,
} from '../lib/navigation';
import {
  EMPTY as NO_TABS,
  close as closeTab,
  cycle as cycleTab,
  move as moveTab,
  open as openTab,
  prune as pruneTabs,
} from '../lib/tabs';
import { ApiError, api } from '../lib/api';
import {
  clearHistory,
  EMPTY_HISTORY,
  type History,
  loadHistory,
  record as recordRevision,
  type RevisionReason,
  revisionsFor,
  saveHistory,
  forget as forgetHistory,
} from '../lib/history';
import type { Command } from '../lib/commands';
import {
  applyTheme,
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  themeById,
  THEMES,
  type Preferences,
} from '../lib/preferences';
import type {
  AnalysisResult,
  HealthInfo,
  RuntimeInfo,
  Symbol as WorkspaceSymbol,
  VirtualFile,
} from '../lib/types';
import {
  createFile,
  loadWorkspace,
  monacoLanguageFor,
  saveWorkspace,
  validateFileName,
} from '../lib/vfs';
import { AgentPanel } from './AgentPanel';
import { AnalysisPanel } from './AnalysisPanel';
import { AssistantPanel } from './AssistantPanel';
import { CommandPalette, type PaletteMode } from './CommandPalette';
import { Breadcrumbs } from './Breadcrumbs';
import { FileExplorer } from './FileExplorer';
import { OutlinePanel } from './OutlinePanel';
import { HistoryPanel } from './HistoryPanel';
import { PreviewPane } from './PreviewPane';
import { RunConfigPanel, parseArgs } from './RunConfigPanel';
import { RuntimePicker } from './RuntimePicker';
import { DiffView } from './DiffView';
import { ExtensionsPanel } from './ExtensionsPanel';
import { SearchPanel } from './SearchPanel';
import { TabStrip } from './TabStrip';
import { SettingsPanel } from './SettingsPanel';
import { TerminalPane, type TerminalHandle } from './TerminalPane';

const ANALYSIS_DEBOUNCE_MS = 700;

/** How long the typing has to stop before the file is worth snapshotting. */
const SNAPSHOT_IDLE_MS = 2500;

/** ANSI helpers keep the console messages readable in one place. */
const ansi = {
  dim: (text: string) => `\x1b[38;5;244m${text}\x1b[0m`,
  accent: (text: string) => `\x1b[1;35m${text}\x1b[0m`,
  good: (text: string) => `\x1b[1;32m${text}\x1b[0m`,
  warn: (text: string) => `\x1b[1;33m${text}\x1b[0m`,
  bad: (text: string) => `\x1b[1;31m${text}\x1b[0m`,
};

export function CodeCraftIDE() {
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const [language, setLanguage] = useState('python');
  const [files, setFiles] = useState<VirtualFile[]>([]);
  const [activeFileId, setActiveFileId] = useState('');

  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisPending, setAnalysisPending] = useState(false);

  const [lastRun, setLastRun] = useState<RunOutcome | null>(null);
  const [bottomTab, setBottomTab] = useState<
    'agent' | 'assistant' | 'analysis' | 'extensions' | 'diff' | 'search' | 'history'
  >('agent');
  const [caret, setCaret] = useState({ line: 1, column: 1 });
  const [selection, setSelection] = useState('');

  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());
  const [paletteMode, setPaletteMode] = useState<PaletteMode | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [symbols, setSymbols] = useState<WorkspaceSymbol[]>([]);
  // Told apart from "this file declares nothing", which looks identical in an
  // empty list and means something completely different. A message rather than
  // a flag, because "no daemon" and "this workspace is too big to index" are
  // two problems with two answers.
  const [symbolsProblem, setSymbolsProblem] = useState<string | null>(null);
  // Read by the definition lookup, which is registered once and must not go
  // stale as the index is refreshed.
  const symbolsRef = useRef<WorkspaceSymbol[]>([]);
  // A search the editor asked for rather than the user typed. A new object
  // each time, so asking twice for the same name is two requests.
  const [searchRequest, setSearchRequest] = useState<
    { query: string; options?: { wholeWord?: boolean } } | null
  >(null);
  const [stdin, setStdin] = useState('');
  const [argsText, setArgsText] = useState('');
  const [statusNote, setStatusNote] = useState('');
  // Monaco is assigned to a ref on mount, which does not re-render. This does.
  const [monacoReady, setMonacoReady] = useState(false);

  const importRef = useRef<HTMLInputElement>(null);
  // Read inside a stable callback, so applying an agent edit does not need to
  // re-subscribe every time the active file changes.
  const activeFileNameRef = useRef('');
  // Read by the snippet provider, which is registered once and would otherwise
  // capture whatever the tab size was at mount.
  const tabSizeRef = useRef(DEFAULT_PREFERENCES.tabSize);
  // The cursor listener is attached once at mount, so it reads the current file
  // through a ref rather than closing over the one that was showing then.
  const activeFileIdRef = useRef('');
  // The snippet provider is registered once, so it reads the extension host
  // through a ref: a snippet contributed after mount has to appear without the
  // provider being registered again.
  const extensionsRef = useRef<ReturnType<typeof useExtensions>['host'] | null>(null);
  // The extension API is built once and must see current state, so it reads
  // these rather than closing over a render's values.
  const filesRef = useRef<VirtualFile[]>([]);
  const extensionHostRef = useRef<ReturnType<typeof useExtensions> | null>(null);

  const terminalRef = useRef<TerminalHandle>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);

  const activeRuntime = runtimes.find((runtime) => runtime.id === language) ?? null;
  const activeFile = files.find((file) => file.id === activeFileId) ?? files[0] ?? null;

  /**
   * Which files have tabs, as distinct from which files exist.
   *
   * The previous strip showed every file, which made it a second file explorer
   * rather than a record of what you are working on.
   */
  /**
   * What was open last time.
   *
   * Read once, before the files arrive: the ids in it are reconciled against
   * the workspace as soon as there is one, and anything pointing at a file that
   * is gone is dropped rather than repaired.
   */
  const restored = useRef(loadSession());
  const [tabs, setTabs] = useState(NO_TABS);

  /**
   * Where the caret has been, so there is a way back.
   *
   * Following a symbol into another file or jumping to a search hit moves you
   * somewhere you did not choose to be, and going back by hand means
   * remembering which file and roughly which line, which nobody does.
   */
  const [places, setPlaces] = useState(NO_PLACES);
  /**
   * The file the open one is being compared against.
   *
   * Two files rather than two versions of one: the local history panel already
   * answers "what did this look like before", and this answers "how do these
   * two differ", which is the question behind a copied file that drifted.
   */
  const [comparingWith, setComparingWith] = useState<string | null>(null);
  /**
   * The files most recently shown, so the palette offers them first.
   *
   * Apart from the tab strip on purpose: tabs are what is open, this is what
   * was recently open, which includes files since closed.
   */
  const [recent, setRecent] = useState<readonly string[]>([]);
  /**
   * A second editor beside the first, showing another file.
   *
   * Both are editable and both write to the same workspace. What the split does
   * not do is move the editor-level commands: jump to line, restore a revision
   * and insert a snippet all act on the left-hand pane, because they are driven
   * from panels that belong to it. Editing in the right-hand pane works and is
   * saved; being the target of those commands is the part that is missing.
   */
  const [splitFileId, setSplitFileId] = useState<string | null>(null);
  // Set while a back or forward is being applied, so moving the caret as a
  // result of navigating does not record a new place and bury the one we came
  // from.
  const navigatingRef = useRef(false);

  // Applied once, when the workspace first has files in it. A second pass would
  // fight with whatever the user has done since.
  const sessionApplied = useRef(false);
  useEffect(() => {
    if (sessionApplied.current || files.length === 0) return;
    sessionApplied.current = true;

    const session = reconcile(restored.current, files.map((file) => file.id));
    if (session.open.length === 0) return;

    setTabs({ open: [...session.open], active: session.active || null });
    setRecent(session.recent);
    if (session.split) setSplitFileId(session.split);
    if (session.active) setActiveFileId(session.active);
  }, [files.length]);

  // Saved on every change rather than on unload: a tab closed by the browser
  // crashing is exactly the case this is for.
  useEffect(() => {
    if (!sessionApplied.current) return;
    saveSession({
      open: [...tabs.open],
      active: tabs.active ?? '',
      split: splitFileId ?? '',
      recent: [...recent],
      collapsed: [],
    });
  }, [tabs, splitFileId, recent]);

  // Showing a file opens a tab for it; deleting one closes its tab.
  useEffect(() => {
    if (activeFile) setTabs((current) => openTab(current, activeFile.id));
    if (activeFile) setRecent((current) => touchRecent(current, activeFile.id));
  }, [activeFile?.id]);

  useEffect(() => {
    setTabs((current) => pruneTabs(current, files.map((file) => file.id)));
    setRecent((current) => pruneRecent(current, files));
    setSplitFileId((current) =>
      current && files.some((file) => file.id === current) ? current : null,
    );
    setPlaces((current) => {
      const alive = new Set(files.map((file) => file.id));
      return current.entries.reduce(
        (state, place) => (alive.has(place.fileId) ? state : forgetPlaces(state, place.fileId)),
        current,
      );
    });
  }, [files]);

  // Closing the tab that was showing has to move the editor too.
  useEffect(() => {
    if (tabs.active && tabs.active !== activeFileId) setActiveFileId(tabs.active);
  }, [tabs.active]);
  /**
   * Snapshots of files as they were, because there is no git in a browser.
   *
   * Held beside the workspace rather than inside it: history has to outlive the
   * file it belongs to, or deleting the wrong file would take the only copy of
   * its contents with it.
   */
  const [history, setHistory] = useState<History>(() => loadHistory());

  useEffect(() => {
    saveHistory(history);
  }, [history]);

  const snapshot = useCallback(
    (fileId: string, name: string, content: string, reason: RevisionReason) => {
      setHistory((current) => recordRevision(current, { fileId, name, content, reason }));
    },
    [],
  );

  // One snapshot per keystroke would be unreadable and would fill the storage
  // quota, so one is taken when the typing stops. Recording declines anything
  // identical to the last snapshot, which is what makes running this on every
  // change harmless.
  useEffect(() => {
    if (!activeFile) return;
    const { id, name, content } = activeFile;
    const timer = window.setTimeout(() => snapshot(id, name, content, 'edit'), SNAPSHOT_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [activeFile?.id, activeFile?.content, snapshot]);

  const isPreviewRuntime = activeRuntime !== null && !activeRuntime.executable;
  /**
   * Markdown gets the preview pane too, whatever runtime is selected.
   *
   * Notes and READMEs sit beside code rather than instead of it, so a markdown
   * file open in a Python workspace should still be readable as a document. The
   * terminal comes back the moment another file is showing.
   */
  const isMarkdown = preferences.markdownPreview && activeFile?.language === 'markdown';
  const splitFile = files.find((file) => file.id === splitFileId) ?? null;

  /**
   * TODO and FIXME notes across the workspace.
   *
   * Recomputed from the files rather than tracked: scanning a workspace is a
   * regex over a few thousand lines, which is cheaper than the bookkeeping that
   * would keep an incremental list correct.
   */
  const todos = useMemo(() => scanWorkspace(files), [files]);


  /** One set of options for both panes, so the split is not a second editor
   *  with settings of its own to drift. */
  const editorOptions = useMemo(
    () => ({
      fontSize: preferences.fontSize,
      fontFamily: '"Fira Code", "JetBrains Mono", monospace',
      fontLigatures: preferences.fontLigatures,
      minimap: { enabled: preferences.minimap, scale: 1 },
      lineNumbers: (preferences.lineNumbers ? 'on' : 'off') as 'on' | 'off',
      wordWrap: (preferences.wordWrap ? 'on' : 'off') as 'on' | 'off',
      tabSize: preferences.tabSize,
      renderWhitespace: (preferences.renderWhitespace ? 'all' : 'selection') as 'all' | 'selection',
      rulers: preferences.rulerColumn > 0 ? [preferences.rulerColumn] : [],
      scrollBeyondLastLine: false,
      automaticLayout: true,
      padding: { top: 12, bottom: 12 },
      smoothScrolling: true,
      cursorBlinking: 'smooth' as const,
      cursorSmoothCaretAnimation: 'on' as const,
      bracketPairColorization: { enabled: true },
      stickyScroll: { enabled: true },
      linkedEditing: true,
      formatOnPaste: true,
      suggestSelection: 'first' as const,
    }),
    [preferences],
  );

  // ------------------------------------------------------------------ startup
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [catalogue, status] = await Promise.all([api.runtimes(), api.health()]);
        if (cancelled) return;

        setRuntimes(catalogue);
        setHealth(status);
        setBootError(null);

        const restored = loadWorkspace();
        if (restored && catalogue.some((runtime) => runtime.id === restored.language)) {
          setLanguage(restored.language);
          setFiles(restored.files);
          setActiveFileId(restored.activeFileId);
          return;
        }

        // Open on a runtime this node can actually execute.
        const preferred =
          catalogue.find((runtime) => runtime.id === 'python' && runtime.installed) ??
          catalogue.find((runtime) => runtime.installed) ??
          catalogue[0];
        if (preferred) {
          setLanguage(preferred.id);
          await loadTemplate(preferred.id, cancelled);
        }
      } catch (error) {
        if (cancelled) return;
        setBootError(
          error instanceof ApiError
            ? error.message
            : 'Could not load the runtime catalogue from the gateway.',
        );
      }
    })();

    return () => {
      cancelled = true;
    };
    // Runs once: the catalogue does not change while the page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updatePreference = useCallback(
    <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
      setPreferences((previous) => {
        const next = { ...previous, [key]: value };
        savePreferences(next);
        return next;
      });
    },
    [],
  );

  // Theme tokens are CSS custom properties on the root, so a change repaints
  // the whole interface without threading colours through every component.
  useEffect(() => {
    applyTheme(themeById(preferences.theme));
  }, [preferences.theme]);

  /** Show a transient note in the status bar. */
  const notify = useCallback((message: string) => {
    setStatusNote(message);
    window.setTimeout(() => setStatusNote((current) => (current === message ? '' : current)), 4000);
  }, []);

  const loadTemplate = useCallback(async (runtimeId: string, cancelled = false) => {
    const template = await api.template(runtimeId);
    if (cancelled) return;
    const file = createFile(template.entry, template.template);
    setFiles([file]);
    setActiveFileId(file.id);
  }, []);

  activeFileNameRef.current = activeFile?.name ?? '';
  tabSizeRef.current = preferences.tabSize;
  activeFileIdRef.current = activeFile?.id ?? '';
  filesRef.current = files;
  symbolsRef.current = symbols;

  /**
   * Persist the workspace so a refresh does not discard work in progress.
   *
   * The one save in this editor whose failure matters. Everything else stored
   * here can be rebuilt by clicking, and local history is the biggest of those
   * things: a megabyte and a half of old versions can be exactly what stops the
   * files themselves from fitting. So a refusal costs the history rather than
   * the work, and says so, because silently stopping saving is how someone
   * loses an afternoon to a reload.
   */
  useEffect(() => {
    if (files.length === 0 || !activeFileId) return;
    if (saveWorkspace({ language, files, activeFileId })) return;

    saveHistory(EMPTY_HISTORY);
    setHistory(clearHistory());
    if (saveWorkspace({ language, files, activeFileId })) {
      notify('Storage was full, so local history was discarded to save your files.');
    } else {
      notify('This browser will not store the workspace. Export it to keep it.');
    }
  }, [language, files, activeFileId, notify]);

  // ----------------------------------------------------------------- analysis
  useEffect(() => {
    if (!activeFile || health?.analyzer === false || !preferences.liveAnalysis) return;

    const timer = window.setTimeout(() => {
      setAnalysisPending(true);
      void api
        .analyze(language, activeFile.content)
        .then((result) => {
          setAnalysis(result);
          setAnalysisError(null);
        })
        .catch((error: unknown) => {
          setAnalysis(null);
          setAnalysisError(
            error instanceof ApiError && error.status === 503
              ? 'The static analyzer has not been built on this node. Run "make analyzer" to enable it.'
              : 'Static analysis is unavailable right now.',
          );
        })
        .finally(() => setAnalysisPending(false));
    }, ANALYSIS_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [activeFile?.content, language, health?.analyzer, activeFile, preferences.liveAnalysis]);

  // Symbols power go-to-symbol and the outline. They come from the assistant's
  // index, which is why this is cheap enough to refresh as the workspace changes.
  useEffect(() => {
    if (files.length === 0) return;
    let cancelled = false;

    const timer = window.setTimeout(() => {
      void api
        .symbols({
          language,
          files: files.map((file) => ({ name: file.name, content: file.content })),
          active_file: activeFile?.name ?? '',
          line: caret.line,
          column: caret.column,
          selection: '',
        })
        .then((result) => {
          if (cancelled) return;
          setSymbols(result.items);
          setSymbolsProblem(null);
        })
        .catch((error: unknown) => {
          // The outline stays empty and says why rather than showing a stale
          // list. A refused request is not an absent daemon, and telling
          // someone to start one they are already running helps nobody.
          if (cancelled) return;
          setSymbols([]);
          setSymbolsProblem(
            error instanceof ApiError && error.status === 422
              ? 'This workspace is too large to index.'
              : 'The assistant daemon is not running, so nothing is indexed.',
          );
        });
    }, 600);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // Only the file contents matter here, not the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, files]);

  // ---------------------------------------------------------------- execution
  const socket = useExecutionSocket({
    onReady: (tier, backend) => {
      terminalRef.current?.writeLine(
        ansi.dim(`Connected. Isolation: ${tier}. Execution backend: ${backend}.`),
      );
    },
    onAccepted: (label) => {
      terminalRef.current?.writeLine(ansi.warn(`Running ${label}…`));
    },
    onOutput: (_stream, content) => {
      terminalRef.current?.write(content);
    },
    onFinished: (outcome) => {
      setLastRun(outcome);
      const summary = outcome.aborted
        ? ansi.warn('Aborted by user')
        : outcome.code === 0
          ? ansi.good(`Finished with exit code 0 in ${outcome.durationMs}ms`)
          : ansi.bad(`Exited with code ${outcome.code} after ${outcome.durationMs}ms`);
      terminalRef.current?.writeLine('');
      terminalRef.current?.writeLine(summary);
      if (outcome.truncated) {
        terminalRef.current?.writeLine(ansi.warn('Output was truncated at the size limit.'));
      }
      terminalRef.current?.writeLine('');
    },
    onError: (message) => {
      terminalRef.current?.writeLine('');
      terminalRef.current?.writeLine(ansi.bad(message));
      terminalRef.current?.writeLine('');
    },
  });

  const handleRun = useCallback(() => {
    if (!activeRuntime || socket.isRunning) return;

    if (!activeRuntime.executable) {
      terminalRef.current?.writeLine(
        ansi.dim(`${activeRuntime.label} renders in the preview pane; there is nothing to run.`),
      );
      return;
    }
    if (!activeRuntime.installed) {
      terminalRef.current?.writeLine(
        ansi.bad(`The toolchain for ${activeRuntime.label} is not installed on this node.`),
      );
      return;
    }

    // The state the code was in when it last ran is the one worth going back
    // to, so it is a landmark in the history rather than an ordinary edit.
    if (activeFile) snapshot(activeFile.id, activeFile.name, activeFile.content, 'run');

    setLastRun(null);
    const args = parseArgs(argsText);
    terminalRef.current?.writeLine(
      ansi.accent(`> ${activeRuntime.label}${args.length ? ` ${args.join(' ')}` : ''}`),
    );
    socket.run({
      language,
      files,
      entry: activeRuntime.entry,
      stdin,
      args,
      limits: {
        wall_seconds: preferences.wallSeconds,
        memory_mb: preferences.memoryMb,
      },
    });
  }, [activeRuntime, activeFile, files, language, socket, stdin, argsText, preferences, snapshot]);

  // Global shortcuts. Monaco owns the ones that act on text; these are the
  // application-level bindings, so they are registered on the window and each
  // one calls preventDefault to stop the browser's own handling.
  /**
   * Bindings, with user overrides applied.
   *
   * Stored as written text against a command id, so a renamed shortcut survives
   * a change to the default and an unparseable one falls back rather than
   * silently removing the binding.
   */
  const bindings = useMemo(
    () => mergeBindings(DEFAULT_BINDINGS, preferences.keybindings ?? {}),
    [preferences.keybindings],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Bindings live in a table rather than in this handler, so they can be
      // listed, displayed and overridden. The handler's only job is to look one
      // up and run it.
      const command = resolveBinding(event, bindings);
      if (!command) return;

      const found = commandsRef.current.find((entry) => entry.id === command);
      if (!found || (found.when && !found.when())) return;

      event.preventDefault();
      found.run();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [bindings]);

  // ------------------------------------------------------------- interactions
  const handleLanguageChange = useCallback(
    async (runtimeId: string) => {
      setLanguage(runtimeId);
      setAnalysis(null);
      try {
        await loadTemplate(runtimeId);
      } catch {
        terminalRef.current?.writeLine(ansi.bad('Could not load the starter template.'));
      }
    },
    [loadTemplate],
  );

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined || !activeFile) return;
      setFiles((previous) =>
        previous.map((file) => (file.id === activeFile.id ? { ...file, content: value } : file)),
      );
    },
    [activeFile],
  );

  /**
   * Put an earlier version of a file back.
   *
   * What is there now is snapshotted first, so restoring the wrong revision
   * costs a second click rather than the work it replaced. When the file is the
   * one on screen the change goes through Monaco, which puts it in the undo
   * stack instead of swapping the model out from under the caret.
   */
  const handleRestore = useCallback(
    (fileId: string, content: string) => {
      const target = files.find((file) => file.id === fileId);
      if (!target || target.content === content) return;

      snapshot(fileId, target.name, target.content, 'restore');
      setFiles((previous) =>
        previous.map((file) => (file.id === fileId ? { ...file, content } : file)),
      );

      const editor = editorRef.current;
      const model = editor?.getModel();
      if (editor && model && fileId === activeFile?.id) {
        editor.executeEdits('codecraft-restore', [
          { range: model.getFullModelRange(), text: content },
        ]);
      }
      notify(`Restored ${target.name}`);
    },
    [files, activeFile?.id, snapshot, notify],
  );

  /** Save the workspace as a JSON file the editor can read back. */
  const handleExport = useCallback(() => {
    const payload = JSON.stringify(
      {
        version: 1,
        language,
        files: files.map((file) => ({ name: file.name, content: file.content })),
      },
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `codecraft-${language}-workspace.json`;
    anchor.click();
    // Revoking immediately can cancel the download in some browsers.
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    notify('Workspace exported.');
  }, [files, language, notify]);

  /**
   * Take files dropped onto the window.
   *
   * Importing through a dialog works and nobody looks for it; dragging source
   * onto the window is what people try first, and it did nothing at all. What
   * is refused and why is decided in one place and reported, because a file
   * that silently does not appear is worse than one with an explanation.
   */
  const handleDropped = useCallback(
    async (dropped: readonly File[]) => {
      const { accepted, refused } = decideDropped(dropped);
      if (accepted.length === 0) {
        notify(explainRefused(refused) || 'Nothing there to open.');
        return;
      }

      // Read first, then add: a half-read drop that has already changed the
      // workspace is worse than one that has not started. Anything that will
      // not read is skipped rather than losing the drop, which is what a
      // dropped folder used to do.
      const { read, unreadable } = await readDropped(accepted);
      const left = [
        ...refused,
        ...unreadable.map((file) => ({ file, because: 'unreadable' as const })),
      ];
      if (read.length === 0) {
        notify(explainRefused(left) || 'Nothing there to open.');
        return;
      }

      // Built outside the updater. A state updater has to be a pure function of
      // what it is given: React may run it twice, and createFile invents an id
      // each time, so an id captured from inside one is not necessarily the id
      // that ended up in the workspace.
      const taken = files.map((file) => file.name);
      const added = read.map((entry) => {
        const name = uniqueName(entry.name, taken);
        taken.push(name);
        return createFile(name, entry.content);
      });

      setFiles((previous) => [...previous, ...added]);
      const opened = added[added.length - 1]?.id;
      if (opened) setActiveFileId(opened);

      const note = `Added ${read.length} ${read.length === 1 ? 'file' : 'files'}.`;
      notify(left.length ? `${note} ${explainRefused(left)}` : note);
    },
    [files, notify],
  );

  /**
   * Rename a file, which is also how it is moved.
   *
   * The folders are part of the name, so renaming `util.py` to `lib/util.py`
   * moves it into `lib` and there is no separate move operation to write. The
   * language follows the extension, because a file renamed from `.txt` to
   * `.py` should be highlighted as Python without being reopened.
   */
  const handleRename = useCallback(
    (fileId: string, name: string) => {
      setFiles((previous) =>
        previous.map((file) =>
          file.id === fileId
            ? { ...file, name, language: monacoLanguageFor(name) }
            : file,
        ),
      );
      notify(`Renamed to ${name}`);
    },
    [notify],
  );

  /**
   * The same workspace as a zip.
   *
   * The JSON export exists to come back into this editor; this one exists to
   * leave it. A zip is what every operating system already opens, what a
   * colleague can read without being told what this is, and what a build system
   * can consume. Written here rather than by a library: an archive of stored
   * entries is three record types and a checksum.
   */
  const handleExportZip = useCallback(() => {
    const archive = zipFiles(
      files.map((file) => ({ name: file.name, content: file.content })),
    );
    const url = URL.createObjectURL(new Blob([archive], { type: 'application/zip' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `codecraft-${language}-workspace.zip`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    notify(`Exported ${files.length} ${files.length === 1 ? 'file' : 'files'} as a zip.`);
  }, [files, language, notify]);

  const handleImportFile = useCallback(
    async (file: File) => {
      try {
        const parsed = JSON.parse(await file.text()) as {
          language?: string;
          files?: { name?: string; content?: string }[];
        };
        const incoming = (parsed.files ?? []).filter(
          (entry): entry is { name: string; content: string } =>
            typeof entry?.name === 'string' && typeof entry?.content === 'string',
        );
        if (incoming.length === 0) {
          notify('That file contains no workspace files.');
          return;
        }

        // Reject a hostile archive rather than writing its paths.
        const accepted: VirtualFile[] = [];
        for (const entry of incoming) {
          if (validateFileName(entry.name, accepted) !== null) {
            notify(`Rejected an unsafe file name: ${entry.name}`);
            return;
          }
          accepted.push(createFile(entry.name, entry.content));
        }

        if (parsed.language && runtimes.some((runtime) => runtime.id === parsed.language)) {
          setLanguage(parsed.language);
        }
        setFiles(accepted);
        setActiveFileId(accepted[0]!.id);
        notify(`Imported ${accepted.length} file(s).`);
      } catch {
        notify('That file is not a CodeCraft workspace.');
      }
    },
    [runtimes, notify],
  );

  /**
   * Go to where the name under the caret was declared.
   *
   * No language server: this is the workspace index the outline already uses,
   * matched by name. It cannot tell two methods called `save` apart, so the one
   * in the file you are in wins and the notification says how many there were.
   */
  const handleGoToDefinition = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (!editor || !model || !position) return;

    const name = wordAt(model.getValue(), model.getOffsetAt(position));
    if (!name) {
      notify('Put the caret on a name first.');
      return;
    }

    const here = activeFileNameRef.current;
    const target = definitionFrom(symbolsRef.current, name, here, position.lineNumber);
    if (!target) {
      notify(describeDeclarations(name, declarationsOf(symbolsRef.current, name, here)));
      return;
    }

    notify(describeDeclarations(name, declarationsOf(symbolsRef.current, name, here)));
    if (target.file === here) {
      handleJumpToLine(target.line);
      return;
    }

    const file = filesRef.current.find((entry) => entry.name === target.file);
    if (!file) {
      notify(`${target.file} is not open in this workspace.`);
      return;
    }
    setActiveFileId(file.id);
    // Let Monaco swap models before the caret is moved, as the search panel
    // does for the same reason.
    window.setTimeout(() => handleJumpToLine(target.line), 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Every use of the name under the caret.
   *
   * A whole-word search across the workspace, and said to be that: without a
   * language server there is no way to tell a use of this `save` from a use of
   * a different one, and a panel that claimed otherwise would be lying.
   */
  const handleFindReferences = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (!editor || !model || !position) return;

    const name = wordAt(model.getValue(), model.getOffsetAt(position));
    if (!name) {
      notify('Put the caret on a name first.');
      return;
    }
    // Whole word, or `save` would match `saved` and `autosave` and the count
    // would mean nothing.
    setSearchRequest({ query: name, options: { wholeWord: true } });
    setBottomTab('search');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleJumpToLine = useCallback((line: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  }, []);

  /**
   * Go to a remembered place.
   *
   * The flag is cleared on a timer rather than immediately: switching files
   * makes Monaco move the caret itself as the model loads, and that movement
   * must not be recorded either.
   */
  const handleNavigate = useCallback(
    (direction: 'back' | 'forward') => {
      const moved = direction === 'back' ? goBack(places) : goForward(places);
      const target = currentPlace(moved);
      if (moved === places || !target) return;

      setPlaces(moved);
      navigatingRef.current = true;
      setActiveFileId(target.fileId);
      window.setTimeout(() => {
        const editor = editorRef.current;
        if (editor) {
          editor.revealLineInCenter(target.line);
          editor.setPosition({ lineNumber: target.line, column: target.column });
          editor.focus();
        }
        navigatingRef.current = false;
      }, 60);
    },
    [places],
  );

  const handleGoToSymbol = useCallback(
    (symbol: WorkspaceSymbol) => {
      const target = files.find((file) => file.name === symbol.file);
      if (target && target.id !== activeFileId) setActiveFileId(target.id);
      // Let the editor swap models before moving the caret.
      window.setTimeout(() => handleJumpToLine(symbol.line), 60);
    },
    [files, activeFileId, handleJumpToLine],
  );


  /**
   * Inline completion, as grey text ahead of the caret.
   *
   * Registered once per Monaco instance rather than per render: the provider
   * reads current state through refs, so re-registering on every keystroke
   * would leak providers for no benefit.
   */
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco || !preferences.inlineCompletion) return;

    const provider = monaco.languages.registerInlineCompletionsProvider('*', {
      provideInlineCompletions: async (model, position, _context, token) => {
        const offset = model.getOffsetAt(position);
        const { prefix, suffix } = contextAround(model.getValue(), offset);

        // Most keystrokes are not a moment worth interrupting.
        if (!shouldRequest(prefix, suffix)) return { items: [] };

        const controller = new AbortController();
        // Monaco cancels as soon as the user types again; without this the
        // request outlives its own relevance and burns a model slot.
        token.onCancellationRequested(() => controller.abort());

        try {
          const answer = await api.infill(prefix, suffix, {
            signal: controller.signal,
            // The server cannot know the language; this is what tells it that
            // a bracket after a `#` is not a bracket.
            lineComment: extensionsRef.current?.languageConfiguration(
              model.getLanguageId(),
            )?.lineComment,
          });
          // A superseded request has an empty completion because a newer one
          // arrived, not because the model had nothing to say.
          if (answer.superseded) return { items: [] };
          const completion = tidy(answer.completion, suffix);
          // The prefix decides whether a completion that starts a new line is
          // finishing the thought or changing the subject.
          if (!worthShowing(completion, suffix, prefix)) return { items: [] };

          return {
            items: [{ insertText: completion, range: new monaco.Range(
              position.lineNumber, position.column, position.lineNumber, position.column,
            ) }],
          };
        } catch {
          // No model running, or the request was cancelled. Either way the
          // editor shows nothing, which is the correct quiet failure.
          return { items: [] };
        }
      },
      freeInlineCompletions: () => {},
    });

    return () => provider.dispose();
  }, [monacoReady, preferences.inlineCompletion]);

  /**
   * Ask for a completion here, and take the best of several.
   *
   * Separate from the grey text that appears as you type, which asks for one
   * and asks often. This asks for four and picks the one the model rates
   * highest, which costs four generations: worth it for a completion someone
   * has stopped to ask for, and not for one offered on every pause.
   */
  const handleCompleteHere = useCallback(async () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (!editor || !model || !position) return;

    const { prefix, suffix } = contextAround(model.getValue(), model.getOffsetAt(position));
    // Four generations take seconds, and the caret is not obliged to wait.
    const versionBefore = model.getVersionId();
    notify('Asking for a completion…');

    try {
      const answer = await api.infill(prefix, suffix, {
        maxTokens: 96,
        candidates: 4,
        lineComment: extensionsRef.current?.languageConfiguration(
          model.getLanguageId(),
        )?.lineComment,
      });
      const completion = tidy(answer.completion, suffix);
      if (!completion.trim()) {
        notify('The model had nothing to add here.');
        return;
      }

      // Inserting at a remembered position in a file that has changed since
      // puts the text somewhere nobody asked for, and it is undoable only if
      // you notice.
      const now = editorRef.current;
      const current = now?.getModel();
      const where = now?.getPosition();
      if (!now || current !== model || model.getVersionId() !== versionBefore || !where) {
        notify('The file changed while the model was thinking, so nothing was inserted.');
        return;
      }

      // Through the editor, so one Ctrl+Z takes it back.
      now.executeEdits('codecraft-complete', [
        { range: new (monacoRef.current!.Range)(
            where.lineNumber, where.column, where.lineNumber, where.column,
          ), text: completion },
      ]);
      now.focus();
      // Why it is shorter than the budget asked for, when the model did not
      // choose to stop: the suggestion left the block it started in, or closed
      // a bracket the file already closes.
      const cut =
        answer.trimmed === 'dedent'
          ? ', cut where it left the block'
          : answer.trimmed === 'bracket'
            ? ', cut before a bracket this line already closes'
            : '';
      notify(`Completed ${answer.tokens} tokens from ${answer.model}${cut}.`);
    } catch {
      notify('No model is running, so there is nothing to complete with.');
    }
  }, [notify]);

  /**
   * Insert a snippet at the caret, placeholders and all.
   *
   * Monaco expands snippet syntax through a controller on the editor rather
   * than through a public method, so it is reached by name. Falling back to a
   * plain edit keeps the text correct when that name ever changes: the
   * placeholders would appear literally, which is visible and fixable, rather
   * than nothing happening at all.
   */
  const handleInsertSnippet = useCallback(
    (snippet: SnippetContribution) => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      const position = editor?.getPosition();
      if (!editor || !model || !position) return;

      const line = model.getLineContent(position.lineNumber);
      const leading = line.slice(0, line.length - line.trimStart().length);
      const body = reindent(snippet.body, preferences.tabSize, leading);

      const controller = editor.getContribution('snippetController2') as
        | { insert?: (text: string) => void }
        | null;

      if (controller?.insert) {
        controller.insert(body);
      } else {
        editor.executeEdits('codecraft-snippet', [
          { range: new (monacoRef.current!.Range)(
              position.lineNumber, position.column, position.lineNumber, position.column,
            ), text: body },
        ]);
      }
      editor.focus();
    },
    [preferences.tabSize],
  );


  /**
   * Snippets in the completion list.
   *
   * Separate from inline completion and from the model: these are shapes that
   * are always right, they cost nothing to offer, and they work with no model
   * running at all. Registered once, reading the language through a ref for the
   * same reason the inline provider does.
   */
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco || !preferences.snippets) return;

    const provider = monaco.languages.registerCompletionItemProvider('*', {
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const line = model.getLineContent(position.lineNumber);
        // What the snippet's continuation lines have to line up with.
        const leading = line.slice(0, line.length - line.trimStart().length);

        const range = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        );

        return {
          suggestions: matchingSnippets(
            extensionsRef.current?.snippetsFor(model.getLanguageId()) ?? [],
            word.word,
          ).map((entry) => ({
            label: entry.prefix,
            kind: monaco.languages.CompletionItemKind.Snippet,
            detail: entry.description,
            documentation: { value: '```\n' + reindent(entry.body, tabSizeRef.current) + '\n```' },
            insertText: reindent(entry.body, tabSizeRef.current, leading),
            insertTextRules:
              monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          })),
        };
      },
    });

    return () => provider.dispose();
  }, [monacoReady, preferences.snippets]);

  /**
   * What a name is, on hover.
   *
   * The declaration line from the workspace index, which is the one piece of
   * information a hover can give honestly without a language server: this is
   * where the name was declared and this is what the line says. No types, no
   * documentation, no inference.
   */
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    const provider = monaco.languages.registerHoverProvider('*', {
      provideHover: (model, position) => {
        const name = wordAt(model.getValue(), model.getOffsetAt(position));
        if (!name) return null;

        const found = declarationsOf(symbolsRef.current, name, activeFileNameRef.current);
        if (found.length === 0) return null;

        const [first, ...rest] = found;
        if (!first) return null;
        const lines = [
          `**${first.kind}** \`${first.name}\``,
          '```',
          first.detail || first.name,
          '```',
          `${first.file}:${first.line}`,
        ];
        if (rest.length > 0) {
          lines.push(`and ${rest.length} more ${rest.length === 1 ? 'declaration' : 'declarations'} of this name`);
        }
        return { contents: [{ value: lines.join('\n') }] };
      },
    });

    return () => provider.dispose();
  }, [monacoReady]);

  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
      setMonacoReady(true);
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => handleRun());

      // The assistant answers about where the caret is and what is selected,
      // so both are tracked as they change.
      editor.onDidChangeCursorPosition((event) => {
        setCaret({ line: event.position.lineNumber, column: event.position.column });

        // Applying a back or forward moves the caret too; recording that would
        // bury the place we just came from under the place we just went to.
        if (navigatingRef.current) return;
        const fileId = activeFileIdRef.current;
        if (!fileId) return;
        setPlaces((current) =>
          visitPlace(current, {
            fileId,
            line: event.position.lineNumber,
            column: event.position.column,
          }),
        );
      });
      editor.onDidChangeCursorSelection(() => {
        const model = editor.getModel();
        const range = editor.getSelection();
        setSelection(model && range && !range.isEmpty() ? model.getValueInRange(range) : '');
      });
    },
    [handleRun],
  );

  /**
   * What extensions are allowed to do to the editor.
   *
   * Every method is a request this component fulfils, so an extension cannot
   * reach past it into editor internals. Rebuilt when its dependencies change;
   * the host is handed the new object rather than being recreated, so the
   * registry survives.
   */
  const extensionHostApi = useMemo(
    () => ({
      replaceActiveFile: (content: string) => {
        const editor = editorRef.current;
        const model = editor?.getModel();
        if (!editor || !model) return;
        // Pushed as an edit rather than setValue so one Ctrl+Z takes it back.
        editor.executeEdits('extension', [{ range: model.getFullModelRange(), text: content }]);
      },
      insertAtCursor: (text: string) => {
        const editor = editorRef.current;
        const selection = editor?.getSelection();
        if (!editor || !selection) return;
        editor.executeEdits('extension', [{ range: selection, text }]);
      },
      openFile: (name: string) => {
        const target = filesRef.current.find((file) => file.name === name);
        if (target) setActiveFileId(target.id);
      },
      createFile: (name: string, content: string) => {
        const created = createFile(name, content);
        setFiles((previous) => [...previous, created]);
        setActiveFileId(created.id);
      },
      runCommand: (id: string) => {
        void extensionHostRef.current?.host.runCommand(id, currentContextRef.current());
      },
      notify: (message: string) => notify(message),
      setStatus: (message: string) => notify(message),
    }),
    // The host is reached through a ref rather than a dependency, because the
    // host owns this object and this object can invoke the host: taking it as a
    // dependency would be a cycle.
    [notify],
  );

  const extensions = useExtensions(extensionHostApi, language);
  // Assigned here rather than with the other refs, which are set before this
  // hook runs. The snippet provider reads it on demand, long after mount.
  extensionsRef.current = extensions.host;

  /**
   * The Monaco theme to use: a contributed one if it is still contributed, and
   * the interface theme's base otherwise.
   */
  const editorTheme = extensions.host.allThemes().some((theme) => theme.id === preferences.editorTheme)
    ? preferences.editorTheme
    : themeById(preferences.theme).monacoBase;

  /**
   * Editor colour schemes contributed by extensions.
   *
   * Defined with Monaco when they arrive and again whenever the set changes, so
   * enabling a theme extension makes its themes selectable without a reload.
   * A theme named in preferences but no longer contributed falls back to the
   * interface theme rather than leaving Monaco with a name it cannot resolve.
   */
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    for (const theme of extensions.host.allThemes()) {
      monaco.editor.defineTheme(theme.id, {
        base: theme.base,
        // Inherited, so a contribution is a short list of overrides rather than
        // a complete scheme that would still miss whatever Monaco adds next.
        inherit: true,
        rules: [],
        colors: theme.colors,
      });
    }
  }, [monacoReady, extensions]);

  /**
   * Comment markers and brackets for the language on screen.
   *
   * Monaco ships configurations for the languages it knows and nothing for the
   * rest, so Ctrl+/ did nothing in a file whose language it has never heard of.
   * An extension can now say what a comment looks like, and the editor obeys.
   *
   * Registered per language rather than once: Monaco keys these by language id,
   * and a configuration registered for the wrong one is worse than none.
   */
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    const configuration = extensions.host.languageConfiguration(
      activeFile?.language ?? language,
    );
    if (!configuration) return;

    const disposable = monaco.languages.setLanguageConfiguration(configuration.language, {
      comments: {
        lineComment: configuration.lineComment,
        blockComment: configuration.blockComment
          ? [configuration.blockComment[0], configuration.blockComment[1]]
          : undefined,
      },
      brackets: configuration.brackets?.map(([open, close]) => [open, close] as [string, string]),
    });

    return () => disposable.dispose();
  }, [monacoReady, extensions, activeFile?.language, language]);

  /**
   * What extensions put in the status bar.
   *
   * Rendered here rather than in the bar so the bar stays a presentation
   * component, and recomputed on the same inputs the contributions read, which
   * is every keystroke and every caret move. Each is a few string operations
   * over one file.
   */
  const statusItems = useMemo(() => {
    const context = editorContextFrom(
      files,
      activeFile,
      language,
      selection,
      caret.line,
      caret.column,
    );
    return extensions.host
      .allStatusBar()
      .map((contribution) => {
        const item = contribution.render(context);
        return item ? { id: contribution.id, alignment: contribution.alignment, ...item } : null;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }, [extensions, files, activeFile, language, selection, caret.line, caret.column]);

  /**
   * Whether the local model is running.
   *
   * Probed once at startup and again when inline completion is switched on,
   * rather than polled: a model that is not running is the common case, and
   * asking every few seconds would be noise for a fact that rarely changes.
   */
  const [modelStatus, setModelStatus] = useState<{ available: boolean; model?: string } | null>(
    null,
  );
  useEffect(() => {
    if (!preferences.inlineCompletion) return;
    let cancelled = false;

    api
      .modelStatus()
      .then((status) => {
        if (!cancelled) setModelStatus(status);
      })
      .catch(() => {
        if (!cancelled) setModelStatus({ available: false });
      });

    return () => {
      cancelled = true;
    };
  }, [preferences.inlineCompletion]);
  extensionHostRef.current = extensions;

  /** The snapshot handed to commands and status bar items. */
  const currentContextRef = useRef(() =>
    editorContextFrom(filesRef.current, null, '', '', 1, 1),
  );
  currentContextRef.current = () =>
    editorContextFrom(files, activeFile ?? null, language, selection, caret.line, caret.column);

  /** Diagnostics contributed by enabled linters, alongside the analyzer's. */
  const extensionDiagnostics = useMemo(
    () => extensions.lint(activeFile ?? null, language),
    [extensions, activeFile, language],
  );

  const allDiagnostics = useMemo(
    () => [...(analysis?.diagnostics ?? []), ...extensionDiagnostics],
    [analysis, extensionDiagnostics],
  );

  // Surface analyzer and extension diagnostics as Monaco markers.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const model = editor.getModel();
    if (!model) return;

    const markers = allDiagnostics.map((diagnostic) => ({
      startLineNumber: diagnostic.line,
      endLineNumber: diagnostic.line,
      startColumn: diagnostic.column,
      endColumn: diagnostic.column + 1,
      message: `${diagnostic.message} (${diagnostic.rule})`,
      severity:
        diagnostic.severity === 'error'
          ? monaco.MarkerSeverity.Error
          : diagnostic.severity === 'warning'
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
    }));

    monaco.editor.setModelMarkers(model, 'codecraft-analyzer', markers);
  }, [allDiagnostics]);

  /**
   * Apply a file the agent wrote.
   *
   * An existing file is edited through Monaco so a single undo takes the change
   * back; a new one is added to the workspace.
   */
  /**
   * The state before the agent's most recent edit to each file.
   *
   * Kept so a change can be reviewed rather than only observed. The agent's
   * edits already go through Monaco's undo stack, so this is about seeing what
   * happened, not about being able to take it back.
   */
  const [agentEdits, setAgentEdits] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState<string | null>(null);

  const handleAgentFileChanged = useCallback(
    (name: string, content: string) => {
      setFiles((previous) => {
        const priorContent = previous.find((file) => file.name === name)?.content ?? '';
        // Only the first edit in a run records a baseline: a second edit to the
        // same file should still diff against what the user last saw, not
        // against the agent's own intermediate state.
        setAgentEdits((edits) =>
          name in edits ? edits : { ...edits, [name]: priorContent },
        );
        // Recording the content the agent is about to replace, which is the
        // version someone will want back if the rewrite went wide. Safe to run
        // from inside the updater because recording identical content is
        // declined, so a second invocation adds nothing.
        const replaced = previous.find((file) => file.name === name);
        if (replaced) snapshot(replaced.id, replaced.name, replaced.content, 'assistant');
        return previous;
      });

      setFiles((previous) => {
        const existing = previous.find((file) => file.name === name);
        if (!existing) {
          const created = createFile(name, content);
          setActiveFileId(created.id);
          return [...previous, created];
        }
        return previous.map((file) =>
          file.id === existing.id ? { ...file, content } : file,
        );
      });

      // When the agent edits the file on screen, push it through the editor so
      // the change lands in its undo stack rather than replacing the model.
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (editor && model && name === activeFileNameRef.current && model.getValue() !== content) {
        editor.executeEdits('codecraft-agent', [
          { range: model.getFullModelRange(), text: content, forceMoveMarkers: true },
        ]);
      }
    },
    [snapshot],
  );

  /** Replace the active file with code the assistant produced. */
  const handleApplyCode = useCallback(
    (code: string) => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!editor || !model) return;
      if (activeFile) snapshot(activeFile.id, activeFile.name, activeFile.content, 'assistant');
      // Pushed as an edit operation rather than setValue, so a single Ctrl+Z
      // takes it back.
      editor.executeEdits('codecraft-assistant', [
        { range: model.getFullModelRange(), text: code, forceMoveMarkers: true },
      ]);
      editor.focus();
    },
    [activeFile, snapshot],
  );

  /** Apply a text action to the selection, or to the file when there is none. */
  const applyTextAction = useCallback(
    (transform: (text: string) => string) => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      const currentSelection = editor?.getSelection();
      if (!editor || !model) return;

      if (currentSelection && !currentSelection.isEmpty()) {
        const text = model.getValueInRange(currentSelection);
        editor.executeEdits('extension', [
          { range: currentSelection, text: transform(text) },
        ]);
      } else {
        editor.executeEdits('extension', [
          { range: model.getFullModelRange(), text: transform(model.getValue()) },
        ]);
      }
      editor.focus();
    },
    [],
  );

  /**
   * Commands contributed by extensions, folded into the same palette as the
   * built-in ones so there is one list rather than two that drift apart.
   */
  const extensionCommands: Command[] = useMemo(() => {
    const actions = extensions.host.allTextActions().map((action) => ({
      id: action.id,
      title: action.title,
      category: action.category,
      run: () => applyTextAction(action.transform),
    }));

    const contributed = extensions.host.allCommands().map((command) => ({
      id: command.id,
      title: command.title,
      category: command.category,
      shortcut: command.shortcut,
      run: () => {
        void extensions.host.runCommand(command.id, currentContextRef.current());
      },
    }));

    return [...actions, ...contributed];
  }, [extensions, applyTextAction]);

  const commands: Command[] = useMemo(
    () => [
      {
        id: 'run.execute',
        title: socket.isRunning ? 'Abort the running program' : 'Run the workspace',
        category: 'Run',
        shortcut: 'Ctrl+Enter',
        run: () => (socket.isRunning ? socket.abort() : handleRun()),
      },
      {
        id: 'palette.commands',
        title: 'Show all commands',
        category: 'Navigate',
        shortcut: 'Ctrl+Shift+P',
        run: () => setPaletteMode('commands'),
      },
      {
        id: 'view.files',
        title: 'Go to file',
        category: 'Navigate',
        shortcut: 'Ctrl+P',
        run: () => setPaletteMode('files'),
      },
      {
        id: 'view.symbols',
        title: 'Go to symbol',
        category: 'Navigate',
        shortcut: 'Ctrl+Shift+O',
        run: () => setPaletteMode('symbols'),
      },
      {
        id: 'navigate.definition',
        title: 'Go to definition',
        category: 'Navigate',
        shortcut: 'F12',
        run: handleGoToDefinition,
      },
      {
        id: 'navigate.references',
        title: 'Find every use of this name',
        category: 'Navigate',
        shortcut: 'Shift+F12',
        run: handleFindReferences,
      },
      {
        id: 'view.settings',
        title: 'Open settings',
        category: 'View',
        shortcut: 'Ctrl+,',
        run: () => setSettingsOpen(true),
      },
      {
        id: 'view.zen',
        title: preferences.zenMode ? 'Leave zen mode' : 'Enter zen mode',
        category: 'View',
        shortcut: 'Ctrl+K Z',
        run: () => updatePreference('zenMode', !preferences.zenMode),
      },
      {
        id: 'view.assistant',
        title: 'Show the assistant',
        category: 'View',
        run: () => setBottomTab('assistant'),
      },
      {
        id: 'view.analysis',
        title: 'Show static analysis',
        category: 'View',
        run: () => setBottomTab('analysis'),
      },
      {
        id: 'view.wrap',
        title: preferences.wordWrap ? 'Disable word wrap' : 'Enable word wrap',
        category: 'View',
        shortcut: 'Alt+Z',
        run: () => updatePreference('wordWrap', !preferences.wordWrap),
      },
      {
        id: 'view.minimap',
        title: preferences.minimap ? 'Hide the minimap' : 'Show the minimap',
        category: 'View',
        run: () => updatePreference('minimap', !preferences.minimap),
      },
      {
        id: 'view.fontUp',
        title: 'Increase font size',
        category: 'View',
        run: () => updatePreference('fontSize', Math.min(28, preferences.fontSize + 1)),
      },
      {
        id: 'view.fontDown',
        title: 'Decrease font size',
        category: 'View',
        run: () => updatePreference('fontSize', Math.max(9, preferences.fontSize - 1)),
      },
      ...THEMES.map((theme) => ({
        id: `theme.${theme.id}`,
        title: `Theme: ${theme.label}`,
        category: 'Theme',
        run: () => updatePreference('theme', theme.id),
      })),
      {
        id: 'editor.format',
        title: 'Format document',
        category: 'Edit',
        shortcut: 'Shift+Alt+F',
        run: () => {
          void editorRef.current?.getAction('editor.action.formatDocument')?.run();
        },
      },
      {
        id: 'editor.comment',
        title: 'Toggle line comment',
        category: 'Edit',
        shortcut: 'Ctrl+/',
        run: () => {
          void editorRef.current?.getAction('editor.action.commentLine')?.run();
        },
      },
      {
        id: 'editor.find',
        title: 'Find in this file',
        category: 'Edit',
        shortcut: 'Ctrl+F',
        run: () => {
          void editorRef.current?.getAction('actions.find')?.run();
        },
      },
      {
        id: 'editor.replace',
        title: 'Replace in this file',
        category: 'Edit',
        shortcut: 'Ctrl+H',
        run: () => {
          void editorRef.current?.getAction('editor.action.startFindReplaceAction')?.run();
        },
      },
      {
        id: 'workspace.export',
        title: 'Export workspace as JSON',
        category: 'Workspace',
        run: handleExport,
      },
      {
        id: 'workspace.import',
        title: 'Import workspace from JSON',
        category: 'Workspace',
        run: () => importRef.current?.click(),
      },
      {
        id: 'workspace.newFile',
        title: 'New file',
        category: 'Workspace',
        run: () => {
          const name = window.prompt('File name');
          if (!name) return;
          const problem = validateFileName(name, files);
          if (problem) {
            notify(problem);
            return;
          }
          const file = createFile(name.trim(), '');
          setFiles((previous) => [...previous, file]);
          setActiveFileId(file.id);
        },
      },
      {
        id: 'console.clear',
        title: 'Clear the console',
        category: 'Run',
        run: () => terminalRef.current?.clear(),
      },
      {
        id: 'view.search',
        title: 'Search across files',
        category: 'Navigate',
        shortcut: 'Ctrl+Shift+F',
        run: () => setBottomTab('search'),
      },
      {
        id: 'tabs.close',
        title: 'Close the current tab',
        category: 'View',
        shortcut: 'Ctrl+W',
        when: () => tabs.active !== null,
        run: () => setTabs((current) => (current.active ? closeTab(current, current.active) : current)),
      },
      {
        id: 'tabs.next',
        title: 'Next tab',
        category: 'Navigate',
        shortcut: 'Ctrl+Tab',
        run: () => setTabs((current) => cycleTab(current, 1)),
      },
      {
        id: 'tabs.previous',
        title: 'Previous tab',
        category: 'Navigate',
        shortcut: 'Ctrl+Shift+Tab',
        run: () => setTabs((current) => cycleTab(current, -1)),
      },
      {
        id: 'tabs.closeOthers',
        title: 'Close other tabs',
        category: 'View',
        when: () => tabs.open.length > 1,
        run: () =>
          setTabs((current) =>
            current.active ? { open: [current.active], active: current.active } : current,
          ),
      },
      {
        id: 'view.extensions',
        title: 'Show extensions',
        category: 'View',
        run: () => setBottomTab('extensions'),
      },
      {
        id: 'assistant.countTokens',
        title: 'Count the tokens in this file',
        category: 'Assistant',
        when: () => modelStatus?.available === true && activeFile !== null,
        run: () => {
          if (!activeFile) return;
          void api
            .tokenize(activeFile.content)
            .then(({ tokens, characters, context }) => {
              const share = context > 0 ? Math.round((tokens / context) * 100) : 0;
              notify(
                `${tokens.toLocaleString()} tokens, ${characters.toLocaleString()} characters` +
                  (context > 0 ? ` — ${share}% of the model's ${context}-token context` : ''),
              );
            })
            .catch(() => notify('No model is running, so there is nothing to count with.'));
        },
      },
      {
        id: 'assistant.completeHere',
        title: 'Complete here, best of four',
        category: 'Assistant',
        when: () => modelStatus?.available === true,
        run: () => void handleCompleteHere(),
      },
      {
        id: 'view.nextProblem',
        title: 'Go to the next problem',
        category: 'Navigate',
        shortcut: 'F8',
        when: () => allDiagnostics.length > 0,
        run: () => {
          const lines = allDiagnostics.map((diagnostic) => diagnostic.line);
          const line = nextAfter(lines, caret.line);
          if (line === null) return;
          handleJumpToLine(line);
          notify(`Problem ${problemPosition(lines, line)}`);
        },
      },
      {
        id: 'view.previousProblem',
        title: 'Go to the previous problem',
        category: 'Navigate',
        shortcut: 'Shift+F8',
        when: () => allDiagnostics.length > 0,
        run: () => {
          const lines = allDiagnostics.map((diagnostic) => diagnostic.line);
          const line = previousBefore(lines, caret.line);
          if (line === null) return;
          handleJumpToLine(line);
          notify(`Problem ${problemPosition(lines, line)}`);
        },
      },
      {
        id: 'view.lastFile',
        title: 'Switch to the last file',
        category: 'Navigate',
        shortcut: 'Ctrl+E',
        when: () => previousFile(recent) !== null,
        run: () => {
          // The second entry, not the first: the first is what is on screen, so
          // this makes the shortcut a toggle between two files.
          const back = previousFile(recent);
          if (back) setActiveFileId(back);
        },
      },
      {
        id: 'view.split',
        title: splitFileId ? 'Close the split editor' : 'Open a file beside this one',
        category: 'View',
        when: () => files.length > 1,
        run: () => {
          if (splitFileId) {
            setSplitFileId(null);
            return;
          }
          // The file you had open before this one is almost always the one you
          // want beside it, so it opens without asking and the header changes it.
          const beside = recent.find((id) => id !== activeFile?.id);
          if (beside) setSplitFileId(beside);
          else setPaletteMode('split');
        },
      },
      {
        id: 'edit.compare',
        title: 'Compare this file with another',
        category: 'Navigate',
        when: () => files.length > 1 && activeFile !== null,
        run: () => setPaletteMode('compare'),
      },
      {
        id: 'workspace.exportZip',
        title: 'Download the workspace as a zip',
        category: 'Workspace',
        when: () => files.length > 0,
        run: handleExportZip,
      },
      {
        id: 'navigate.back',
        title: 'Go back',
        category: 'Navigate',
        shortcut: 'Alt+Left',
        when: () => canGoBack(places),
        run: () => handleNavigate('back'),
      },
      {
        id: 'navigate.forward',
        title: 'Go forward',
        category: 'Navigate',
        shortcut: 'Alt+Right',
        when: () => canGoForward(places),
        run: () => handleNavigate('forward'),
      },
      {
        id: 'edit.snippet',
        title: 'Insert a snippet',
        category: 'Edit',
        when: () =>
          extensions.host.snippetsFor(activeFile?.language ?? language).length > 0,
        run: () => setPaletteMode('snippets'),
      },
      {
        id: 'view.history',
        title: 'Show local history',
        category: 'View',
        run: () => setBottomTab('history'),
      },
      {
        id: 'history.restoreLast',
        title: 'Restore the last snapshot of this file',
        category: 'Edit',
        when: () =>
          activeFile !== null && revisionsFor(history, activeFile.id).length > 0,
        run: () => {
          if (!activeFile) return;
          const [newest] = revisionsFor(history, activeFile.id);
          if (newest) handleRestore(activeFile.id, newest.content);
        },
      },
      {
        id: 'history.clearAll',
        title: 'Discard all local history',
        category: 'Edit',
        when: () => Object.keys(history).length > 0,
        run: () => {
          setHistory(clearHistory());
          notify('Local history discarded for every file.');
        },
      },
      {
        id: 'history.clearFile',
        title: 'Discard local history for this file',
        category: 'Edit',
        when: () => activeFile !== null && revisionsFor(history, activeFile.id).length > 0,
        run: () => {
          if (!activeFile) return;
          setHistory((current) => forgetHistory(current, activeFile.id));
          notify('History cleared for this file');
        },
      },
      {
        id: 'edit.format',
        title: 'Format the file',
        category: 'Edit',
        shortcut: 'Ctrl+Shift+I',
        when: () => extensions.host.formatterFor(language) !== null,
        run: () => {
          const formatter = extensions.host.formatterFor(language);
          if (!formatter) return;
          applyTextAction((text) =>
            formatter.format(text, { tabSize: preferences.tabSize, insertSpaces: true }),
          );
          notify(`Formatted with ${formatter.id}`);
        },
      },
      ...extensionCommands,
    ],
    [
      socket,
      handleRun,
      preferences,
      updatePreference,
      handleExport,
      handleExportZip,
      files,
      notify,
      extensionCommands,
      extensions,
      language,
      applyTextAction,
      tabs,
      activeFile,
      history,
      handleRestore,
      places,
      handleNavigate,
      splitFileId,
      recent,
      allDiagnostics,
      caret.line,
      handleJumpToLine,
      handleCompleteHere,
      modelStatus,
      handleInsertSnippet,
    ],
  );

  // The keydown handler is registered before `commands` exists, so it reads the
  // current list through a ref rather than being re-registered on every change.
  const commandsRef = useRef<Command[]>([]);
  commandsRef.current = commands;

  const statusBadge = useMemo(() => {
    if (!lastRun) return null;
    const good = lastRun.code === 0 && !lastRun.aborted;
    return (
      <span
        className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
          good
            ? 'border-emerald-800/40 bg-emerald-950/50 text-run'
            : 'border-rose-800/40 bg-rose-950/50 text-halt'
        }`}
      >
        exit {lastRun.code} · {lastRun.durationMs}ms
      </span>
    );
  }, [lastRun]);

  if (bootError) {
    return <BootError message={bootError} />;
  }

  const zen = preferences.zenMode;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-obsidian font-sans text-slate-200 antialiased selection:bg-indigo-500/30">
      <CommandPalette
        mode={paletteMode}
        commands={commands}
        files={byRecency(files, recent)}
        symbols={symbols}
        snippets={extensions.host.snippetsFor(activeFile?.language ?? language)}
        onClose={() => setPaletteMode(null)}
        onOpenFile={setActiveFileId}
        onGoToSymbol={handleGoToSymbol}
        onInsertSnippet={handleInsertSnippet}
        onSplitFile={(fileId) => {
          setSplitFileId(fileId);
          setPaletteMode(null);
        }}
        onCompareFile={(fileId) => {
          setComparingWith(fileId);
          setBottomTab('diff');
          setPaletteMode(null);
        }}
      />
      <SettingsPanel
        open={settingsOpen}
        preferences={preferences}
        editorThemes={extensions.host.allThemes()}
        onChange={updatePreference}
        onReset={() => {
          setPreferences({ ...DEFAULT_PREFERENCES });
          savePreferences({ ...DEFAULT_PREFERENCES });
          notify('Settings reset to defaults.');
        }}
        onClose={() => setSettingsOpen(false)}
      />
      <input
        ref={importRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleImportFile(file);
          // Reset so importing the same file twice still fires a change event.
          event.target.value = '';
        }}
      />

      {!zen && (
        <TopBar
          runtimes={runtimes}
          language={language}
          onLanguageChange={handleLanguageChange}
          isRunning={socket.isRunning}
          canRun={activeRuntime?.executable === true && activeRuntime.installed}
          onRun={handleRun}
          onAbort={socket.abort}
          connection={socket.connection}
          health={health}
          onOpenPalette={() => setPaletteMode('commands')}
          onOpenSettings={() => setSettingsOpen(true)}
          onExport={handleExport}
          onImport={() => importRef.current?.click()}
          onToggleZen={() => updatePreference('zenMode', true)}
        />
      )}

      <div
        className="flex min-h-0 flex-1"
        // On the whole workspace rather than on the editor: people aim at the
        // window, not at a particular pane.
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          void handleDropped(Array.from(event.dataTransfer.files));
        }}
      >
        {!zen && (
        <FileExplorer
          files={files}
          activeFileId={activeFile?.id ?? ''}
          entryName={activeRuntime?.entry ?? ''}
          onSelect={setActiveFileId}
          onRename={handleRename}
          onCreate={(name) => {
            const file = createFile(name, '');
            setFiles((previous) => [...previous, file]);
            setActiveFileId(file.id);
          }}
          onDelete={(id) => {
            setFiles((previous) => {
              const remaining = previous.filter((file) => file.id !== id);
              if (id === activeFileId && remaining[0]) setActiveFileId(remaining[0].id);
              return remaining;
            });
          }}
          outline={
            <OutlinePanel
              symbols={symbols}
              fileName={activeFile?.name ?? ''}
              line={caret.line}
              problem={symbolsProblem}
              onJump={handleJumpToLine}
            />
          }
        />
        )}

        <main className="flex min-w-0 flex-1 flex-col border-r border-slate-800/80">
          <TabStrip
            files={files}
            open={tabs.open}
            active={tabs.active}
            entryName={activeRuntime?.entry ?? ''}
            onSelect={setActiveFileId}
            onClose={(fileId) => setTabs((current) => closeTab(current, fileId))}
            onReorder={(fileId, to) => setTabs((current) => moveTab(current, fileId, to))}
          />
          {activeFile ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <Breadcrumbs
                fileName={activeFile.name}
                symbols={symbols}
                line={caret.line}
                onJump={handleJumpToLine}
              />
              <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1">
                <Editor
                  key={activeFile.id}
                  height="100%"
                  language={activeFile.language}
                  theme={editorTheme}
                  value={activeFile.content}
                  onChange={handleEditorChange}
                  onMount={handleEditorMount}
                  loading={
                    <div className="flex h-full items-center justify-center text-xs text-slate-500">
                      Loading editor…
                    </div>
                  }
                  options={editorOptions}
                />
              </div>

              {splitFile && (
                <div className="flex min-w-0 flex-1 flex-col border-l border-slate-800/80">
                  <header className="flex h-7 shrink-0 items-center justify-between border-b border-slate-800/80 bg-charcoal px-2">
                    <button
                      type="button"
                      onClick={() => setPaletteMode('split')}
                      className="min-w-0 truncate font-mono text-[11px] text-slate-400 transition-colors hover:text-slate-200"
                      title="Show another file here"
                    >
                      {splitFile.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSplitFileId(null)}
                      aria-label="Close the split"
                      className="shrink-0 rounded p-0.5 text-slate-600 transition-colors hover:bg-slate-800 hover:text-slate-200"
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </header>
                  <div className="min-h-0 flex-1">
                    <Editor
                      key={`split:${splitFile.id}`}
                      height="100%"
                      language={splitFile.language}
                      theme={editorTheme}
                      value={splitFile.content}
                      onChange={(value) => {
                        if (value === undefined) return;
                        setFiles((previous) =>
                          previous.map((file) =>
                            file.id === splitFile.id ? { ...file, content: value } : file,
                          ),
                        );
                      }}
                      options={editorOptions}
                    />
                  </div>
                </div>
              )}
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-slate-500">
              Loading workspace…
            </div>
          )}
        </main>

        {/*
          min-h-0 lets the flex children shrink below their content height. The
          terminal reports an intrinsic height from its rendered rows, and
          without this it pushes past the column and paints over the panel
          below, swallowing clicks meant for that panel's header.
        */}
        <div
          className={`flex min-h-0 flex-col overflow-hidden ${
            zen ? 'hidden' : 'w-[38%] min-w-[320px]'
          }`}
        >
          <RunConfigPanel
            stdin={stdin}
            argsText={argsText}
            onStdinChange={setStdin}
            onArgsChange={setArgsText}
          />
          {/*
            A flex container, not a block: the terminal sizes itself to its
            rendered rows, and inside a block wrapper it grows past the
            available height and paints over the panel below it.
          */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {isMarkdown ? (
              <PreviewPane files={files} entryName={activeFile?.name ?? ''} markdown />
            ) : isPreviewRuntime ? (
              <PreviewPane files={files} entryName={activeRuntime?.entry ?? 'index.html'} />
            ) : (
              <TerminalPane
                ref={terminalRef}
                status={statusBadge}
                palette={themeById(preferences.theme).terminal}
                fontSize={preferences.fontSize}
              />
            )}
          </div>
          <div className="flex h-[46%] min-h-0 flex-col border-t border-slate-800/80 bg-panel">
            {bottomTab === 'agent' ? (
              <AgentPanel
                language={language}
                files={files}
                activeFileName={activeFile?.name ?? ''}
                onFileChanged={handleAgentFileChanged}
              />
            ) : bottomTab === 'assistant' ? (
              <AssistantPanel
                language={language}
                files={files}
                activeFileName={activeFile?.name ?? ''}
                selection={selection}
                caret={caret}
                onApplyCode={handleApplyCode}
              />
            ) : bottomTab === 'search' ? (
              <SearchPanel
                files={files}
                request={searchRequest}
                onOpen={(fileId, line) => {
                  if (fileId !== activeFileId) setActiveFileId(fileId);
                  // Let the editor swap models before moving the caret.
                  window.setTimeout(() => handleJumpToLine(line), 60);
                }}
                onReplace={(changes) => {
                  // Replace across files is the change most likely to be
                  // regretted, and the one undo cannot reach in the files that
                  // are not on screen.
                  for (const change of changes) {
                    const before = files.find((file) => file.id === change.fileId);
                    if (before) snapshot(before.id, before.name, before.content, 'replace');
                  }
                  setFiles((previous) =>
                    previous.map((file) => {
                      const change = changes.find((entry) => entry.fileId === file.id);
                      return change ? { ...file, content: change.content } : file;
                    }),
                  );
                  // The file on screen goes through Monaco, so one Ctrl+Z takes
                  // the whole replacement back rather than leaving it stranded.
                  const editor = editorRef.current;
                  const model = editor?.getModel();
                  const onScreen = changes.find((entry) => entry.name === activeFileNameRef.current);
                  if (editor && model && onScreen) {
                    editor.executeEdits('codecraft-replace', [
                      { range: model.getFullModelRange(), text: onScreen.content },
                    ]);
                  }
                  notify(`Replaced in ${changes.length} ${changes.length === 1 ? 'file' : 'files'}`);
                }}
              />
            ) : bottomTab === 'diff' ? (
              comparingWith && activeFile ? (
                <DiffView
                  name={`${files.find((file) => file.id === comparingWith)?.name ?? '?'} → ${activeFile.name}`}
                  before={files.find((file) => file.id === comparingWith)?.content ?? ''}
                  after={activeFile.content}
                  onClose={() => setComparingWith(null)}
                />
              ) : reviewing && agentEdits[reviewing] !== undefined ? (
                <DiffView
                  name={reviewing}
                  before={agentEdits[reviewing]!}
                  after={files.find((file) => file.name === reviewing)?.content ?? ''}
                  onAccept={() => {
                    setAgentEdits(({ [reviewing]: _dropped, ...rest }) => rest);
                    setReviewing(null);
                    setBottomTab('agent');
                  }}
                />
              ) : (
                <p className="p-3 text-xs text-slate-500">
                  Nothing to review. Files the agent changes appear here.
                </p>
              )
            ) : bottomTab === 'history' ? (
              <HistoryPanel
                history={history}
                file={activeFile}
                files={files}
                onRestore={handleRestore}
                onRecover={(name, content) => {
                  // A new file, because the id the snapshots refer to is gone
                  // and so is anything that pointed at it.
                  const recovered = createFile(uniqueName(name, files.map((file) => file.name)), content);
                  setFiles((previous) => [...previous, recovered]);
                  setActiveFileId(recovered.id);
                  notify(`Recovered ${recovered.name}`);
                }}
                onForget={(fileId) => {
                  setHistory((current) => forgetHistory(current, fileId));
                  notify('History cleared for this file');
                }}
              />
            ) : bottomTab === 'extensions' ? (
              <ExtensionsPanel
                extensions={extensions.extensions}
                onToggle={extensions.setEnabled}
              />
            ) : (
              <>
                <header className="flex h-9 shrink-0 items-center gap-2 border-b border-slate-800/80 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <Cpu className="h-3.5 w-3.5 text-caret" aria-hidden />
                  <span>Static analysis</span>
                  {analysisPending && (
                    <Loader2 className="ml-auto h-3 w-3 animate-spin text-slate-600" aria-hidden />
                  )}
                </header>
                <AnalysisPanel
                  analysis={analysis}
                  error={analysisError}
                  pending={analysisPending}
                  extensionDiagnostics={extensionDiagnostics}
                  todos={todos}
                  onJumpToLine={handleJumpToLine}
                  onOpenTodo={(fileId, line) => {
                    if (fileId !== activeFileId) setActiveFileId(fileId);
                    // Let the editor swap models before moving the caret.
                    window.setTimeout(() => handleJumpToLine(line), 60);
                  }}
                />
              </>
            )}

            <nav className="flex h-8 shrink-0 items-center gap-1 border-t border-slate-800/80 bg-charcoal px-2">
              <PaneTab
                active={bottomTab === 'agent'}
                onClick={() => setBottomTab('agent')}
                icon={Zap}
                label="Agent"
              />
              <PaneTab
                active={bottomTab === 'assistant'}
                onClick={() => setBottomTab('assistant')}
                icon={Sparkles}
                label="Assistant"
              />
              <PaneTab
                active={bottomTab === 'analysis'}
                onClick={() => setBottomTab('analysis')}
                icon={Cpu}
                label="Analysis"
                // Notes in the open file are already among the diagnostics,
                // because the linter and the panel share one scan. Counting
                // them again here would show every TODO twice.
                badge={
                  allDiagnostics.length +
                  outstanding(todos.filter((todo) => todo.fileId !== activeFile?.id))
                }
              />
              <PaneTab
                active={bottomTab === 'search'}
                onClick={() => setBottomTab('search')}
                icon={Search}
                label="Search"
              />
              <PaneTab
                active={bottomTab === 'diff'}
                onClick={() => {
                  setReviewing((current) => current ?? Object.keys(agentEdits)[0] ?? null);
                  setBottomTab('diff');
                }}
                icon={GitCompare}
                label="Changes"
                badge={Object.keys(agentEdits).length || undefined}
              />
              <PaneTab
                active={bottomTab === 'history'}
                onClick={() => setBottomTab('history')}
                icon={HistoryIcon}
                label="History"
                badge={activeFile ? revisionsFor(history, activeFile.id).length || undefined : undefined}
              />
              <PaneTab
                active={bottomTab === 'extensions'}
                onClick={() => setBottomTab('extensions')}
                icon={Package}
                label="Extensions"
                badge={extensions.extensions.filter((state) => state.enabled).length}
              />
            </nav>
          </div>
        </div>
      </div>

      <StatusBar
        language={activeRuntime?.label ?? language}
        toolchain={activeRuntime?.toolchain ?? null}
        fileName={activeFile?.name ?? ''}
        items={statusItems}
        symbolCount={symbols.length}
        diagnosticCount={allDiagnostics.length}
        modelName={modelStatus?.available ? (modelStatus.model ?? 'local model') : null}
        lastRun={lastRun}
        note={statusNote}
        zen={zen}
        onLeaveZen={() => updatePreference('zenMode', false)}
        onOpenPalette={() => setPaletteMode('commands')}
      />
    </div>
  );
}

/** Open files as a tab strip, so switching does not need the explorer. */
function StatusBar({
  language,
  toolchain,
  fileName,
  items,
  symbolCount,
  diagnosticCount,
  lastRun,
  note,
  zen,
  onLeaveZen,
  modelName,
  onOpenPalette,
}: {
  language: string;
  toolchain: string | null;
  fileName: string;
  /**
   * What extensions want in the bar, already rendered.
   *
   * Cursor position, selection size, the language, the file's size, its line
   * endings and its real indentation all come from the Status Bar Items
   * extension. They used to be written here as well, which meant an extension
   * that contributed them changed nothing and could not be turned off.
   */
  items: { id: string; text: string; tooltip?: string; tone?: string; alignment: 'left' | 'right' }[];
  symbolCount: number;
  diagnosticCount: number;
  lastRun: RunOutcome | null;
  note: string;
  /** The local model behind inline completion, or null when none is running. */
  modelName: string | null;
  zen: boolean;
  onLeaveZen: () => void;
  onOpenPalette: () => void;
}) {
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-slate-800/80 bg-charcoal px-3 font-mono text-[10px] text-slate-500">
      <button
        type="button"
        onClick={onOpenPalette}
        className="text-slate-400 transition-colors hover:text-indigo-300"
        title="Command palette (Ctrl+Shift+P)"
      >
        ⌘ commands
      </button>

      {fileName && <span className="truncate text-slate-400">{fileName}</span>}
      {items
        .filter((item) => item.alignment === 'left')
        .map((item) => (
          <StatusItem key={item.id} item={item} />
        ))}
      <span className="truncate">{toolchain ?? language}</span>

      <span className="ml-auto flex items-center gap-3">
        {note && <span className="text-indigo-300">{note}</span>}
        {modelName && (
          <span className="truncate text-caret" title="Inline completion is backed by this model">
            {modelName}
          </span>
        )}
        {items
          .filter((item) => item.alignment === 'right')
          .map((item) => (
            <StatusItem key={item.id} item={item} />
          ))}
        {symbolCount > 0 && <span>{symbolCount} symbols</span>}
        <span className={diagnosticCount > 0 ? 'text-amber-400' : ''}>
          {diagnosticCount} problem{diagnosticCount === 1 ? '' : 's'}
        </span>
        {lastRun && (
          <span className={lastRun.code === 0 ? 'text-run' : 'text-halt'}>
            exit {lastRun.code} · {lastRun.durationMs}ms
          </span>
        )}
        {zen && (
          <button
            type="button"
            onClick={onLeaveZen}
            className="text-slate-400 hover:text-slate-100"
            title="Leave zen mode (Esc)"
          >
            zen ✕
          </button>
        )}
      </span>
    </footer>
  );
}

/** One contributed item, in the tone it asked for. */
function StatusItem({
  item,
}: {
  item: { text: string; tooltip?: string; tone?: string };
}) {
  const tone =
    item.tone === 'danger'
      ? 'text-halt'
      : item.tone === 'warning'
        ? 'text-amber-400'
        : item.tone === 'accent'
          ? 'text-caret'
          : '';
  return (
    <span className={`truncate ${tone}`} title={item.tooltip}>
      {item.text}
    </span>
  );
}

// ---------------------------------------------------------------------------

interface TopBarProps {
  runtimes: RuntimeInfo[];
  language: string;
  onLanguageChange: (id: string) => void;
  isRunning: boolean;
  canRun: boolean;
  onRun: () => void;
  onAbort: () => void;
  connection: 'connecting' | 'open' | 'closed';
  health: HealthInfo | null;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  onExport: () => void;
  onImport: () => void;
  onToggleZen: () => void;
}

function TopBar({
  runtimes,
  language,
  onLanguageChange,
  isRunning,
  canRun,
  onRun,
  onAbort,
  connection,
  health,
  onOpenPalette,
  onOpenSettings,
  onExport,
  onImport,
  onToggleZen,
}: TopBarProps) {
  const tier = health?.isolation_tier ?? 'unknown';
  const hardened = tier === 'nsjail' || tier === 'userns';

  // The header's backdrop-blur creates a stacking context, so it needs its own
  // z-index; without one the runtime dropdown paints behind the panes below it.
  return (
    <header className="relative z-40 flex h-12 shrink-0 items-center justify-between border-b border-indigo-900/30 bg-charcoal/80 px-3 backdrop-blur-xl">
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-tr from-indigo-600 via-purple-600 to-pink-500 shadow-lg shadow-indigo-500/30">
          <Code2 className="h-4 w-4 text-white" aria-hidden />
        </div>
        <span className="font-mono text-sm font-bold tracking-wide text-slate-100">
          CodeCraft Studio
        </span>
        {health && (
          <span className="rounded border border-indigo-800/40 bg-indigo-950/60 px-1.5 py-0.5 font-sans text-[10px] text-indigo-300">
            v{health.version}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2.5">
        <RuntimePicker
          runtimes={runtimes}
          value={language}
          onChange={onLanguageChange}
          disabled={isRunning}
        />

        <AnimatePresence mode="wait" initial={false}>
          {isRunning ? (
            <motion.button
              key="abort"
              type="button"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              whileTap={{ scale: 0.97 }}
              onClick={onAbort}
              className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-rose-600 to-pink-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-lg shadow-rose-600/20 transition-[filter] hover:brightness-110"
            >
              <Square className="h-3 w-3 fill-current" aria-hidden />
              Abort
            </motion.button>
          ) : (
            <motion.button
              key="run"
              type="button"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              whileTap={{ scale: 0.97 }}
              onClick={onRun}
              disabled={!canRun}
              title={canRun ? 'Run (Ctrl+Enter)' : 'This runtime cannot run on this node'}
              className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 shadow-lg shadow-emerald-500/20 transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:from-slate-700 disabled:via-slate-700 disabled:to-slate-700 disabled:text-slate-500 disabled:shadow-none"
            >
              <Play className="h-3 w-3 fill-current" aria-hidden />
              Run
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <div className="flex items-center gap-2 font-mono text-[10px] text-slate-400">
        <div className="flex items-center gap-0.5">
          <ToolbarButton icon={Search} label="Command palette (Ctrl+Shift+P)" onClick={onOpenPalette} />
          <ToolbarButton icon={Download} label="Export workspace" onClick={onExport} />
          <ToolbarButton icon={Upload} label="Import workspace" onClick={onImport} />
          <ToolbarButton icon={Maximize2} label="Zen mode (F11)" onClick={onToggleZen} />
          <ToolbarButton icon={SettingsIcon} label="Settings (Ctrl+,)" onClick={onOpenSettings} />
        </div>
        <StatusChip
          icon={hardened ? ShieldCheck : ShieldAlert}
          tone={hardened ? 'good' : 'warn'}
          label={tier}
          title={
            hardened
              ? `Kernel isolation active (${tier})`
              : 'No kernel isolation on this node: resource limits and a deadline only'
          }
        />
        <StatusChip
          icon={connection === 'open' ? Wifi : WifiOff}
          tone={connection === 'open' ? 'good' : 'warn'}
          label={connection}
          title={`Gateway connection is ${connection}`}
        />
      </div>
    </header>
  );
}

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Download;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded p-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

function StatusChip({
  icon: Icon,
  tone,
  label,
  title,
}: {
  icon: typeof ShieldCheck;
  tone: 'good' | 'warn';
  label: string;
  title: string;
}) {
  return (
    <span
      title={title}
      className="flex items-center gap-1.5 rounded border border-slate-800 bg-slate-900/60 px-2 py-1"
    >
      <Icon className={`h-3 w-3 ${tone === 'good' ? 'text-run' : 'text-amber-400'}`} aria-hidden />
      <span>{label}</span>
    </span>
  );
}

function PaneTab({
  active,
  onClick,
  icon: Icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Cpu;
  label: string;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded px-2 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors ${
        active
          ? 'bg-indigo-950/60 text-indigo-200'
          : 'text-slate-500 hover:bg-slate-800/50 hover:text-slate-300'
      }`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="rounded-full bg-rose-950/70 px-1.5 text-[9px] text-halt">{badge}</span>
      )}
    </button>
  );
}

function BootError({ message }: { message: string }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-obsidian p-6 text-slate-200">
      <div className="max-w-lg rounded-xl border border-rose-900/40 bg-charcoal p-6 shadow-2xl">
        <div className="mb-3 flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-halt" aria-hidden />
          <h1 className="text-sm font-semibold">CodeCraft Studio could not start</h1>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-slate-400">{message}</p>
        <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-obsidian p-3 font-mono text-[11px] leading-relaxed text-slate-300">
          {'make backend    # start the gateway on port 8000\nmake dev        # start gateway and frontend together'}
        </pre>
      </div>
    </div>
  );
}
