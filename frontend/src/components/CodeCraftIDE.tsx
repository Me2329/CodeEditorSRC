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
  Loader2,
  Maximize2,
  Play,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Upload,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useExecutionSocket, type RunOutcome } from '../hooks/useExecutionSocket';
import { ApiError, api } from '../lib/api';
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
import { createFile, loadWorkspace, saveWorkspace, validateFileName } from '../lib/vfs';
import { AnalysisPanel } from './AnalysisPanel';
import { AssistantPanel } from './AssistantPanel';
import { CommandPalette, type PaletteMode } from './CommandPalette';
import { FileExplorer } from './FileExplorer';
import { PreviewPane } from './PreviewPane';
import { RunConfigPanel, parseArgs } from './RunConfigPanel';
import { RuntimePicker } from './RuntimePicker';
import { SettingsPanel } from './SettingsPanel';
import { TerminalPane, type TerminalHandle } from './TerminalPane';

const ANALYSIS_DEBOUNCE_MS = 700;

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
  const [bottomTab, setBottomTab] = useState<'assistant' | 'analysis'>('assistant');
  const [caret, setCaret] = useState({ line: 1, column: 1 });
  const [selection, setSelection] = useState('');

  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());
  const [paletteMode, setPaletteMode] = useState<PaletteMode | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [symbols, setSymbols] = useState<WorkspaceSymbol[]>([]);
  const [stdin, setStdin] = useState('');
  const [argsText, setArgsText] = useState('');
  const [statusNote, setStatusNote] = useState('');

  const importRef = useRef<HTMLInputElement>(null);

  const terminalRef = useRef<TerminalHandle>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);

  const activeRuntime = runtimes.find((runtime) => runtime.id === language) ?? null;
  const activeFile = files.find((file) => file.id === activeFileId) ?? files[0] ?? null;
  const isPreviewRuntime = activeRuntime !== null && !activeRuntime.executable;

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

  // Persist the workspace so a refresh does not discard work in progress.
  useEffect(() => {
    if (files.length === 0 || !activeFileId) return;
    saveWorkspace({ language, files, activeFileId });
  }, [language, files, activeFileId]);

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
          if (!cancelled) setSymbols(result.items);
        })
        .catch(() => {
          // The assistant daemon may not be running; the outline stays empty
          // and the palette says so rather than showing a stale list.
          if (!cancelled) setSymbols([]);
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
  }, [activeRuntime, files, language, socket, stdin, argsText, preferences]);

  // Global shortcuts. Monaco owns the ones that act on text; these are the
  // application-level bindings, so they are registered on the window and each
  // one calls preventDefault to stop the browser's own handling.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;

      if (modifier && event.key === 'Enter') {
        event.preventDefault();
        if (socket.isRunning) socket.abort();
        else handleRun();
        return;
      }
      if (modifier && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setPaletteMode('commands');
        return;
      }
      if (modifier && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        setPaletteMode('symbols');
        return;
      }
      if (modifier && !event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setPaletteMode('files');
        return;
      }
      if (modifier && event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (event.altKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        updatePreference('wordWrap', !preferences.wordWrap);
        return;
      }
      if (event.key === 'F11') {
        event.preventDefault();
        updatePreference('zenMode', !preferences.zenMode);
        return;
      }
      if (event.key === 'Escape' && preferences.zenMode) {
        updatePreference('zenMode', false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleRun, socket, preferences.wordWrap, preferences.zenMode, updatePreference]);

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

  const handleJumpToLine = useCallback((line: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  }, []);

  const handleGoToSymbol = useCallback(
    (symbol: WorkspaceSymbol) => {
      const target = files.find((file) => file.name === symbol.file);
      if (target && target.id !== activeFileId) setActiveFileId(target.id);
      // Let the editor swap models before moving the caret.
      window.setTimeout(() => handleJumpToLine(symbol.line), 60);
    },
    [files, activeFileId, handleJumpToLine],
  );

  // Surface analyzer diagnostics as Monaco markers on the active file.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const model = editor.getModel();
    if (!model) return;

    const markers = (analysis?.diagnostics ?? []).map((diagnostic) => ({
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
  }, [analysis]);

  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => handleRun());

      // The assistant answers about where the caret is and what is selected,
      // so both are tracked as they change.
      editor.onDidChangeCursorPosition((event) => {
        setCaret({ line: event.position.lineNumber, column: event.position.column });
      });
      editor.onDidChangeCursorSelection(() => {
        const model = editor.getModel();
        const range = editor.getSelection();
        setSelection(model && range && !range.isEmpty() ? model.getValueInRange(range) : '');
      });
    },
    [handleRun],
  );

  /** Replace the active file with code the assistant produced. */
  const handleApplyCode = useCallback(
    (code: string) => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!editor || !model) return;
      // Pushed as an edit operation rather than setValue, so a single Ctrl+Z
      // takes it back.
      editor.executeEdits('codecraft-assistant', [
        { range: model.getFullModelRange(), text: code, forceMoveMarkers: true },
      ]);
      editor.focus();
    },
    [],
  );

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
    ],
    [socket, handleRun, preferences, updatePreference, handleExport, files, notify],
  );

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
        files={files}
        symbols={symbols}
        onClose={() => setPaletteMode(null)}
        onOpenFile={setActiveFileId}
        onGoToSymbol={handleGoToSymbol}
      />
      <SettingsPanel
        open={settingsOpen}
        preferences={preferences}
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

      <div className="flex min-h-0 flex-1">
        {!zen && (
        <FileExplorer
          files={files}
          activeFileId={activeFile?.id ?? ''}
          entryName={activeRuntime?.entry ?? ''}
          onSelect={setActiveFileId}
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
        />
        )}

        <main className="flex min-w-0 flex-1 flex-col border-r border-slate-800/80">
          <EditorTabs
            files={files}
            activeFileId={activeFile?.id ?? ''}
            entryName={activeRuntime?.entry ?? ''}
            onSelect={setActiveFileId}
          />
          {activeFile ? (
            <Editor
              key={activeFile.id}
              height="100%"
              language={activeFile.language}
              theme={themeById(preferences.theme).monacoBase}
              value={activeFile.content}
              onChange={handleEditorChange}
              onMount={handleEditorMount}
              loading={
                <div className="flex h-full items-center justify-center text-xs text-slate-500">
                  Loading editor…
                </div>
              }
              options={{
                fontSize: preferences.fontSize,
                fontFamily: '"Fira Code", "JetBrains Mono", monospace',
                fontLigatures: preferences.fontLigatures,
                minimap: { enabled: preferences.minimap, scale: 1 },
                lineNumbers: preferences.lineNumbers ? 'on' : 'off',
                wordWrap: preferences.wordWrap ? 'on' : 'off',
                tabSize: preferences.tabSize,
                renderWhitespace: preferences.renderWhitespace ? 'all' : 'selection',
                rulers: preferences.rulerColumn > 0 ? [preferences.rulerColumn] : [],
                scrollBeyondLastLine: false,
                automaticLayout: true,
                padding: { top: 12, bottom: 12 },
                smoothScrolling: true,
                cursorBlinking: 'smooth',
                cursorSmoothCaretAnimation: 'on',
                bracketPairColorization: { enabled: true },
                stickyScroll: { enabled: true },
                linkedEditing: true,
                formatOnPaste: true,
                suggestSelection: 'first',
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-slate-500">
              Loading workspace…
            </div>
          )}
        </main>

        <div className={`flex flex-col ${zen ? 'hidden' : 'w-[38%] min-w-[320px]'}`}>
          <RunConfigPanel
            stdin={stdin}
            argsText={argsText}
            onStdinChange={setStdin}
            onArgsChange={setArgsText}
          />
          <div className="min-h-0 flex-1">
            {isPreviewRuntime ? (
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
            {bottomTab === 'assistant' ? (
              <AssistantPanel
                language={language}
                files={files}
                activeFileName={activeFile?.name ?? ''}
                selection={selection}
                caret={caret}
                onApplyCode={handleApplyCode}
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
                  onJumpToLine={handleJumpToLine}
                />
              </>
            )}

            <nav className="flex h-8 shrink-0 items-center gap-1 border-t border-slate-800/80 bg-charcoal px-2">
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
                badge={analysis?.diagnostics.length}
              />
            </nav>
          </div>
        </div>
      </div>

      <StatusBar
        language={activeRuntime?.label ?? language}
        toolchain={activeRuntime?.toolchain ?? null}
        fileName={activeFile?.name ?? ''}
        caret={caret}
        tabSize={preferences.tabSize}
        selectionLength={selection.length}
        symbolCount={symbols.length}
        diagnosticCount={analysis?.diagnostics.length ?? 0}
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
function EditorTabs({
  files,
  activeFileId,
  entryName,
  onSelect,
}: {
  files: VirtualFile[];
  activeFileId: string;
  entryName: string;
  onSelect: (id: string) => void;
}) {
  if (files.length <= 1) return null;

  return (
    <nav className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-slate-800/80 bg-charcoal">
      {files.map((file) => {
        const active = file.id === activeFileId;
        return (
          <button
            key={file.id}
            type="button"
            onClick={() => onSelect(file.id)}
            aria-current={active}
            className={`flex shrink-0 items-center gap-1.5 border-r border-slate-800/80 px-3 font-mono text-[11px] transition-colors ${
              active
                ? 'border-b-2 border-b-accent bg-obsidian text-slate-100'
                : 'text-slate-500 hover:bg-slate-800/40 hover:text-slate-300'
            }`}
          >
            {file.name}
            {file.name === entryName && (
              <span className="text-[8px] uppercase text-run" title="Entry point">
                entry
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

function StatusBar({
  language,
  toolchain,
  fileName,
  caret,
  tabSize,
  selectionLength,
  symbolCount,
  diagnosticCount,
  lastRun,
  note,
  zen,
  onLeaveZen,
  onOpenPalette,
}: {
  language: string;
  toolchain: string | null;
  fileName: string;
  caret: { line: number; column: number };
  tabSize: number;
  selectionLength: number;
  symbolCount: number;
  diagnosticCount: number;
  lastRun: RunOutcome | null;
  note: string;
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
      <span>
        Ln {caret.line}, Col {caret.column}
      </span>
      {selectionLength > 0 && <span>{selectionLength} selected</span>}
      <span>Spaces: {tabSize}</span>
      <span className="truncate">
        {language}
        {toolchain ? ` · ${toolchain}` : ''}
      </span>

      <span className="ml-auto flex items-center gap-3">
        {note && <span className="text-indigo-300">{note}</span>}
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
