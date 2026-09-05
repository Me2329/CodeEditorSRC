/**
 * The agent panel.
 *
 * Give it a task and it works the way a developer would: read the code, change
 * it, run it, read the output, fix what broke. Every step is shown as it
 * happens - which tool, with what arguments, and what came back - so the run is
 * auditable rather than a black box that eventually edits your files.
 *
 * Plan mode is the safe default for unfamiliar work: the agent investigates and
 * proposes, but its write and run tools are withheld by the daemon, not merely
 * hidden here.
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CornerDownLeft,
  Eye,
  FileEdit,
  FileSearch,
  ListTree,
  Loader2,
  Play,
  Search,
  Square,
  Trash2,
  Wrench,
  Zap,
} from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { useAgentSocket, type AgentStatus } from '../hooks/useAgentSocket';
import type { AgentFrame, AgentMode, Effort, VirtualFile, WorkspaceContext } from '../lib/types';

/** One entry in the run timeline. */
type Entry =
  | { kind: 'step'; id: string; number: number; of: number }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: Record<string, unknown> | null;
      status: 'running' | 'ok' | 'error';
      summary: string;
    }
  | { kind: 'file'; id: string; name: string; lines: number }
  | {
      kind: 'end';
      id: string;
      reason: string;
      steps: number;
      elapsedMs: number;
      costCents: number;
    }
  | { kind: 'error'; id: string; message: string };

interface Props {
  language: string;
  files: VirtualFile[];
  activeFileName: string;
  /** Apply a file the agent wrote back into the editor. */
  onFileChanged: (name: string, content: string) => void;
}

const TOOL_ICONS: Record<string, typeof Wrench> = {
  read_file: FileSearch,
  list_files: ListTree,
  search: Search,
  analyze: Eye,
  write_file: FileEdit,
  edit_file: FileEdit,
  run_code: Play,
};

const EXAMPLE_TASKS = [
  'Find the bug in this code, fix it, and run it to prove the fix works.',
  'Add error handling and a docstring to every function, then run the file.',
  'Write a test for the main function in a second file and run it.',
  'Refactor this into smaller functions without changing behaviour, then verify.',
];

let entryCounter = 0;
const nextId = () => `e${(entryCounter += 1)}`;

export function AgentPanel({ language, files, activeFileName, onFileChanged }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [task, setTask] = useState('');
  const [mode, setMode] = useState<AgentMode>('auto');
  const [effort, setEffort] = useState<Effort>('high');
  const [maxSteps, setMaxSteps] = useState(24);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Text arrives in fragments; they are merged into the trailing entry so the
  // narration reads as prose rather than a list of tokens.
  const streamingKindRef = useRef<'text' | 'thinking' | null>(null);

  const append = useCallback((entry: Entry) => {
    setEntries((previous) => [...previous, entry]);
  }, []);

  const appendStreamed = useCallback((kind: 'text' | 'thinking', text: string) => {
    setEntries((previous) => {
      const last = previous[previous.length - 1];
      if (last && last.kind === kind && streamingKindRef.current === kind) {
        const merged = { ...last, text: last.text + text };
        return [...previous.slice(0, -1), merged];
      }
      streamingKindRef.current = kind;
      return [...previous, { kind, id: nextId(), text }];
    });
  }, []);

  const handleFrame = useCallback(
    (frame: AgentFrame) => {
      // Any structured event ends the current run of narration.
      if (frame.type !== 'text' && frame.type !== 'thinking') {
        streamingKindRef.current = null;
      }

      switch (frame.type) {
        case 'step':
          append({ kind: 'step', id: nextId(), number: frame.number, of: frame.of });
          break;
        case 'text':
          appendStreamed('text', frame.text);
          break;
        case 'thinking':
          appendStreamed('thinking', frame.text);
          break;
        case 'tool_started':
          append({
            kind: 'tool',
            id: frame.id,
            name: frame.name,
            input: null,
            status: 'running',
            summary: '',
          });
          break;
        case 'tool_call':
          // Fill in the arguments on the entry the start event created.
          setEntries((previous) =>
            previous.map((entry) =>
              entry.kind === 'tool' && entry.id === frame.id
                ? { ...entry, input: frame.input }
                : entry,
            ),
          );
          break;
        case 'tool_result':
          setEntries((previous) =>
            previous.map((entry) =>
              entry.kind === 'tool' && entry.id === frame.id
                ? {
                    ...entry,
                    status: frame.is_error ? 'error' : 'ok',
                    summary: frame.summary,
                  }
                : entry,
            ),
          );
          break;
        case 'file_changed':
          onFileChanged(frame.name, frame.content);
          append({
            kind: 'file',
            id: nextId(),
            name: frame.name,
            lines: frame.content.split('\n').length,
          });
          break;
        case 'finished':
          append({
            kind: 'end',
            id: nextId(),
            reason: frame.reason,
            steps: frame.steps,
            elapsedMs: frame.elapsed_ms,
            costCents: frame.total_cost_cents,
          });
          break;
        case 'failed':
          append({ kind: 'error', id: nextId(), message: frame.message });
          break;
        default:
          break;
      }

      // Follow the run only when already at the bottom.
      window.setTimeout(() => {
        const element = scrollRef.current;
        if (!element) return;
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 160;
        if (atBottom) element.scrollTop = element.scrollHeight;
      }, 0);
    },
    [append, appendStreamed, onFileChanged],
  );

  const socket = useAgentSocket({ onFrame: handleFrame, onStatus: setStatus });

  const workspace: WorkspaceContext = useMemo(
    () => ({
      language,
      files: files.map((file) => ({ name: file.name, content: file.content })),
      active_file: activeFileName,
      line: 0,
      column: 0,
      selection: '',
    }),
    [language, files, activeFileName],
  );

  const start = useCallback(() => {
    const trimmed = task.trim();
    if (!trimmed || socket.isRunning) return;

    setEntries([{ kind: 'text', id: nextId(), text: `Task: ${trimmed}` }]);
    streamingKindRef.current = null;
    socket.run({
      messages: [{ role: 'user', content: trimmed }],
      workspace,
      mode,
      effort,
      maxSteps,
    });
  }, [task, socket, workspace, mode, effort, maxSteps]);

  const blocked = socket.connection !== 'open' || status?.available === false;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-slate-800/80 px-3">
        <Zap className="h-3.5 w-3.5 text-run" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Agent
        </span>
        {status?.model && (
          <span className="truncate rounded border border-emerald-900/40 bg-emerald-950/40 px-1.5 py-0.5 font-mono text-[9px] text-run">
            {status.model}
          </span>
        )}
        <span
          className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${
            mode === 'plan'
              ? 'bg-sky-950/60 text-sky-300'
              : 'bg-amber-950/60 text-amber-300'
          }`}
          title={
            mode === 'plan'
              ? 'Read-only: the agent investigates but changes nothing'
              : 'The agent can edit files and run code in the sandbox'
          }
        >
          {mode}
        </span>

        <div className="ml-auto flex items-center gap-1">
          {entries.length > 0 && !socket.isRunning && (
            <button
              type="button"
              onClick={() => setEntries([])}
              className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
              title="Clear the run log"
              aria-label="Clear the run log"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowSettings((value) => !value)}
            aria-expanded={showSettings}
            aria-label="Agent settings"
            title="Agent settings: mode, effort and step budget"
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-slate-500 hover:bg-slate-800 hover:text-slate-200"
          >
            <span className="font-mono">{effort}</span>
            <ChevronDown
              className={`h-3 w-3 transition-transform ${showSettings ? 'rotate-180' : ''}`}
              aria-hidden
            />
          </button>
        </div>
      </header>

      <AnimatePresence initial={false}>
        {showSettings && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-b border-slate-800/80 bg-obsidian/60"
          >
            <div className="space-y-2.5 p-3">
              <fieldset>
                <legend className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
                  Mode
                </legend>
                <div className="flex gap-1">
                  {(['plan', 'auto'] as AgentMode[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setMode(option)}
                      disabled={socket.isRunning}
                      title={
                        option === 'plan'
                          ? 'Read, search and analyse only. Nothing is changed or run.'
                          : 'Edit files and run code in the sandbox.'
                      }
                      className={`flex-1 rounded border px-2 py-1 text-[10px] transition-colors disabled:opacity-40 ${
                        mode === option
                          ? 'border-indigo-700/60 bg-indigo-950/60 text-indigo-200'
                          : 'border-slate-800 text-slate-400 hover:bg-slate-800/50'
                      }`}
                    >
                      {option === 'plan' ? 'Plan (read-only)' : 'Auto (edit and run)'}
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
                  Effort
                </legend>
                <div className="flex gap-1">
                  {(['low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((level) => (
                    <button
                      key={level}
                      type="button"
                      onClick={() => setEffort(level)}
                      className={`flex-1 rounded border px-1 py-1 font-mono text-[10px] transition-colors ${
                        effort === level
                          ? 'border-purple-700/60 bg-purple-950/60 text-purple-200'
                          : 'border-slate-800 text-slate-400 hover:bg-slate-800/50'
                      }`}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </fieldset>

              <label className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">
                  Step budget
                </span>
                <span className="flex items-center gap-2">
                  <input
                    type="range"
                    min={2}
                    max={60}
                    value={maxSteps}
                    onChange={(event) => setMaxSteps(Number(event.target.value))}
                    className="w-28 accent-indigo-500"
                    aria-label="Step budget"
                  />
                  <span className="w-6 text-right font-mono text-[10px] text-slate-400">
                    {maxSteps}
                  </span>
                </span>
              </label>

              <p className="text-[10px] leading-relaxed text-slate-500">
                The agent works in a copy of your workspace. Changes reach the editor only as
                it makes them, and you can undo any of them.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {entries.length === 0 ? (
          <EmptyState status={status} blocked={blocked} onPick={setTask} />
        ) : (
          entries.map((entry) => <TimelineEntry key={entry.id} entry={entry} />)
        )}
      </div>

      <div className="shrink-0 border-t border-slate-800/80 p-2">
        <div className="flex items-end gap-1.5">
          <textarea
            rows={2}
            value={task}
            disabled={blocked || socket.isRunning}
            placeholder={
              blocked ? 'Agent unavailable' : 'Describe a task. The agent will read, edit and run.'
            }
            onChange={(event) => setTask(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                start();
              }
            }}
            aria-label="Describe a task for the agent"
            className="min-h-[42px] flex-1 resize-none rounded-lg border border-slate-800 bg-slate-900/60 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-slate-200 outline-none placeholder:text-slate-600 focus:border-run disabled:cursor-not-allowed disabled:opacity-50"
          />
          {socket.isRunning ? (
            <button
              type="button"
              onClick={socket.cancel}
              aria-label="Stop the agent"
              className="flex h-[42px] w-9 items-center justify-center rounded-lg bg-gradient-to-br from-rose-600 to-pink-600 text-white transition-[filter] hover:brightness-110"
            >
              <Square className="h-3 w-3 fill-current" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={start}
              disabled={blocked || task.trim().length === 0}
              aria-label="Start the agent"
              className="flex h-[42px] w-9 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-slate-950 transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-600"
            >
              <CornerDownLeft className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function EmptyState({
  status,
  blocked,
  onPick,
}: {
  status: AgentStatus | null;
  blocked: boolean;
  onPick: (task: string) => void;
}) {
  if (status && !status.available) {
    return (
      <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 p-3">
        <p className="text-xs leading-relaxed text-amber-200/90">
          The assistant daemon is not running, so the agent cannot start.
        </p>
        <pre className="mt-2 rounded border border-slate-800 bg-obsidian p-2 font-mono text-[10px] text-slate-400">
          make assistant-daemon
        </pre>
      </div>
    );
  }

  if (status && !status.remoteAvailable) {
    return (
      <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 p-3">
        <p className="text-xs leading-relaxed text-amber-200/90">
          The agent needs a Claude credential. {status.reason}
        </p>
        <pre className="mt-2 rounded border border-slate-800 bg-obsidian p-2 font-mono text-[10px] text-slate-400">
          {'export ANTHROPIC_API_KEY=…\n# or: ant auth login'}
        </pre>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="px-1 text-[11px] leading-relaxed text-slate-500">
        The agent reads your files, changes them, runs the result in the sandbox, and fixes
        what breaks. Every step is shown below as it happens.
      </p>
      {EXAMPLE_TASKS.map((example) => (
        <button
          key={example}
          type="button"
          disabled={blocked}
          onClick={() => onPick(example)}
          className="w-full rounded-lg border border-slate-800 bg-slate-900/40 px-2.5 py-2 text-left text-[11px] text-slate-400 transition-colors hover:border-emerald-800/50 hover:bg-emerald-950/20 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {example}
        </button>
      ))}
    </div>
  );
}

function TimelineEntry({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'step':
      return (
        <div className="flex items-center gap-2 pt-1.5">
          <span className="font-mono text-[9px] uppercase tracking-wider text-slate-600">
            step {entry.number}/{entry.of}
          </span>
          <span className="h-px flex-1 bg-slate-800" />
        </div>
      );

    case 'thinking':
      return (
        <p className="border-l border-slate-800 pl-2 text-[10.5px] italic leading-relaxed text-slate-500">
          {entry.text}
        </p>
      );

    case 'text':
      return (
        <p className="whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-slate-300">
          {entry.text}
        </p>
      );

    case 'tool':
      return <ToolEntry entry={entry} />;

    case 'file':
      return (
        <div className="flex items-center gap-2 rounded border border-emerald-900/40 bg-emerald-950/20 px-2 py-1">
          <FileEdit className="h-3 w-3 shrink-0 text-run" aria-hidden />
          <span className="font-mono text-[10.5px] text-emerald-200">{entry.name}</span>
          <span className="text-[9px] text-slate-500">
            applied to the editor · {entry.lines} lines
          </span>
        </div>
      );

    case 'end': {
      const good = entry.reason === 'finished';
      const label =
        entry.reason === 'finished'
          ? 'Task complete'
          : entry.reason === 'cancelled'
            ? 'Stopped by you'
            : 'Step budget reached before finishing';
      return (
        <div
          className={`mt-1 flex flex-wrap items-center gap-2 rounded border px-2 py-1.5 ${
            good
              ? 'border-emerald-900/40 bg-emerald-950/20 text-run'
              : 'border-amber-900/40 bg-amber-950/20 text-amber-300'
          }`}
        >
          {good ? (
            <Check className="h-3 w-3" aria-hidden />
          ) : (
            <AlertTriangle className="h-3 w-3" aria-hidden />
          )}
          <span className="text-[11px]">{label}</span>
          <span className="ml-auto font-mono text-[9px] text-slate-500">
            {entry.steps} steps · {(entry.elapsedMs / 1000).toFixed(1)}s
            {entry.costCents > 0 ? ` · ${entry.costCents.toFixed(2)}¢` : ''}
          </span>
        </div>
      );
    }

    case 'error':
      return (
        <div className="rounded border border-rose-900/40 bg-rose-950/20 px-2 py-1.5">
          <p className="text-[11px] leading-relaxed text-rose-200">{entry.message}</p>
        </div>
      );
  }
}

function ToolEntry({
  entry,
}: {
  entry: Extract<Entry, { kind: 'tool' }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = TOOL_ICONS[entry.name] ?? Wrench;

  // The most useful argument to show inline, per tool.
  const headline = useMemo(() => {
    const input = entry.input ?? {};
    const value = (key: string) => {
      const found = input[key];
      return typeof found === 'string' ? found : '';
    };
    return value('path') || value('query') || '';
  }, [entry.input]);

  return (
    <div className="rounded border border-slate-800 bg-slate-900/40">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
      >
        <Icon
          className={`h-3 w-3 shrink-0 ${
            entry.status === 'error' ? 'text-halt' : 'text-indigo-400'
          }`}
          aria-hidden
        />
        <span className="font-mono text-[10.5px] text-slate-300">{entry.name}</span>
        {headline && (
          <span className="truncate font-mono text-[10px] text-slate-500">{headline}</span>
        )}
        <span className="ml-auto shrink-0">
          {entry.status === 'running' ? (
            <Loader2 className="h-3 w-3 animate-spin text-slate-600" aria-hidden />
          ) : entry.status === 'error' ? (
            <AlertTriangle className="h-3 w-3 text-halt" aria-hidden />
          ) : (
            <Check className="h-3 w-3 text-run" aria-hidden />
          )}
        </span>
      </button>

      {expanded && (
        <div className="space-y-1.5 border-t border-slate-800 px-2 py-1.5">
          {entry.input && (
            <pre className="overflow-x-auto rounded bg-obsidian p-1.5 font-mono text-[9.5px] leading-relaxed text-slate-400">
              {JSON.stringify(entry.input, null, 2)}
            </pre>
          )}
          {entry.summary && (
            <pre
              className={`overflow-x-auto whitespace-pre-wrap rounded bg-obsidian p-1.5 font-mono text-[9.5px] leading-relaxed ${
                entry.status === 'error' ? 'text-rose-300' : 'text-slate-400'
              }`}
            >
              {entry.summary}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
