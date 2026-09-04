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
  Loader2,
  Play,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useExecutionSocket, type RunOutcome } from '../hooks/useExecutionSocket';
import { ApiError, api } from '../lib/api';
import type { AnalysisResult, HealthInfo, RuntimeInfo, VirtualFile } from '../lib/types';
import { createFile, loadWorkspace, saveWorkspace } from '../lib/vfs';
import { AnalysisPanel } from './AnalysisPanel';
import { AssistantPanel } from './AssistantPanel';
import { FileExplorer } from './FileExplorer';
import { PreviewPane } from './PreviewPane';
import { RuntimePicker } from './RuntimePicker';
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
    if (!activeFile || health?.analyzer === false) return;

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
  }, [activeFile?.content, language, health?.analyzer, activeFile]);

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
    terminalRef.current?.writeLine(ansi.accent(`> ${activeRuntime.label}`));
    socket.run({ language, files, entry: activeRuntime.entry });
  }, [activeRuntime, files, language, socket]);

  // Ctrl+Enter and Cmd+Enter run, matching the editor's own binding.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        if (socket.isRunning) socket.abort();
        else handleRun();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleRun, socket]);

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

  const handleJumpToLine = useCallback((line: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  }, []);

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

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-obsidian font-sans text-slate-200 antialiased selection:bg-indigo-500/30">
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
      />

      <div className="flex min-h-0 flex-1">
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

        <main className="flex min-w-0 flex-1 flex-col border-r border-slate-800/80">
          {activeFile ? (
            <Editor
              key={activeFile.id}
              height="100%"
              language={activeFile.language}
              theme="vs-dark"
              value={activeFile.content}
              onChange={handleEditorChange}
              onMount={handleEditorMount}
              loading={
                <div className="flex h-full items-center justify-center text-xs text-slate-500">
                  Loading editor…
                </div>
              }
              options={{
                fontSize: 13,
                fontFamily: '"Fira Code", "JetBrains Mono", monospace',
                fontLigatures: true,
                minimap: { enabled: true, scale: 1 },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                padding: { top: 12, bottom: 12 },
                smoothScrolling: true,
                cursorBlinking: 'smooth',
                cursorSmoothCaretAnimation: 'on',
                renderWhitespace: 'selection',
                tabSize: 4,
                bracketPairColorization: { enabled: true },
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-slate-500">
              Loading workspace…
            </div>
          )}
        </main>

        <div className="flex w-[38%] min-w-[320px] flex-col">
          <div className="min-h-0 flex-1">
            {isPreviewRuntime ? (
              <PreviewPane files={files} entryName={activeRuntime?.entry ?? 'index.html'} />
            ) : (
              <TerminalPane ref={terminalRef} status={statusBadge} />
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
    </div>
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
