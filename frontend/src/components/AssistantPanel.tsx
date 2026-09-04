/**
 * Assistant chat panel.
 *
 * Two engines sit behind one conversation. Questions the workspace index can
 * answer exactly come back from the local engine in under a millisecond;
 * everything else streams from Claude Mythos 5.1. Each reply says which engine
 * produced it, so the user always knows what they are reading.
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  Bot,
  BrainCircuit,
  ChevronDown,
  CornerDownLeft,
  Copy,
  Loader2,
  Sparkles,
  Square,
  Trash2,
  User,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAssistantSocket, type AssistantStatus } from '../hooks/useAssistantSocket';
import type { AssistantRoute, Effort, VirtualFile, WorkspaceContext } from '../lib/types';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Which engine produced an assistant message. */
  engine?: 'local' | 'model';
  model?: string;
  thinking?: string;
  elapsedMs?: number;
  costCents?: number | null;
  error?: boolean;
}

interface Props {
  language: string;
  files: VirtualFile[];
  activeFileName: string;
  selection: string;
  caret: { line: number; column: number };
  /** Replace the active file's contents with a code block from a reply. */
  onApplyCode: (code: string) => void;
}

const ROUTES: { value: AssistantRoute; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Local engine when it can answer, model otherwise' },
  { value: 'local', label: 'Local', hint: 'Index only. Instant, offline, never calls the model' },
  { value: 'remote', label: 'Model', hint: 'Always ask the model' },
];

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Suggestions shown on an empty conversation, tuned to the current file. */
function starterPrompts(language: string): string[] {
  return [
    'What functions are in this file?',
    `Explain what this ${language} code does, step by step.`,
    'Find the bug in this code and tell me what it does at runtime.',
    'Add error handling and comments explaining the tricky parts.',
  ];
}

export function AssistantPanel({
  language,
  files,
  activeFileName,
  selection,
  caret,
  onApplyCode,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [route, setRoute] = useState<AssistantRoute>('auto');
  const [effort, setEffort] = useState<Effort>('high');
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The id of the assistant message currently being streamed into.
  const streamingIdRef = useRef<string | null>(null);

  const updateStreaming = useCallback((mutate: (message: ChatMessage) => ChatMessage) => {
    const id = streamingIdRef.current;
    if (!id) return;
    setMessages((previous) =>
      previous.map((message) => (message.id === id ? mutate(message) : message)),
    );
  }, []);

  const socket = useAssistantSocket({
    onStatus: setStatus,
    onRouted: (engine, model) => {
      updateStreaming((message) => ({ ...message, engine, model }));
    },
    onThinking: (text) => {
      updateStreaming((message) => ({
        ...message,
        thinking: (message.thinking ?? '') + text,
      }));
    },
    onDelta: (text) => {
      updateStreaming((message) => ({ ...message, content: message.content + text }));
    },
    onDone: (elapsedMs, costCents) => {
      updateStreaming((message) => ({ ...message, elapsedMs, costCents }));
      streamingIdRef.current = null;
    },
    onError: (text) => {
      updateStreaming((message) => ({
        ...message,
        content: message.content || text,
        error: true,
      }));
      streamingIdRef.current = null;
    },
  });

  // Follow the stream, but only while the user is already at the bottom, so
  // scrolling up to read an earlier reply is not fought by new tokens.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    if (atBottom) element.scrollTop = element.scrollHeight;
  }, [messages]);

  const workspace: WorkspaceContext = useMemo(
    () => ({
      language,
      files: files.map((file) => ({ name: file.name, content: file.content })),
      active_file: activeFileName,
      line: caret.line,
      column: caret.column,
      selection,
    }),
    [language, files, activeFileName, caret.line, caret.column, selection],
  );

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || socket.isStreaming) return;

      const userMessage: ChatMessage = {
        id: `u${Date.now().toString(36)}`,
        role: 'user',
        content: trimmed,
      };
      const replyId = `a${Date.now().toString(36)}`;
      const reply: ChatMessage = { id: replyId, role: 'assistant', content: '' };

      const history = [...messages, userMessage].map((message) => ({
        role: message.role,
        content: message.content,
      }));

      setMessages((previous) => [...previous, userMessage, reply]);
      setDraft('');
      streamingIdRef.current = replyId;

      const sent = socket.ask({ messages: history, workspace, route, effort });
      if (!sent) streamingIdRef.current = null;
    },
    [messages, socket, workspace, route, effort],
  );

  const disabled = socket.connection !== 'open' || status?.available === false;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      <Header
        status={status}
        connection={socket.connection}
        route={route}
        effort={effort}
        showSettings={showSettings}
        onToggleSettings={() => setShowSettings((value) => !value)}
        onRouteChange={setRoute}
        onEffortChange={setEffort}
        onClear={() => {
          setMessages([]);
          streamingIdRef.current = null;
        }}
        hasMessages={messages.length > 0}
      />

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 ? (
          <EmptyState
            language={language}
            status={status}
            disabled={disabled}
            onPick={(prompt) => send(prompt)}
          />
        ) : (
          messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              streaming={streamingIdRef.current === message.id}
              onApplyCode={onApplyCode}
            />
          ))
        )}
      </div>

      <Composer
        value={draft}
        disabled={disabled}
        streaming={socket.isStreaming}
        hasSelection={selection.length > 0}
        inputRef={inputRef}
        onChange={setDraft}
        onSend={() => send(draft)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Header({
  status,
  connection,
  route,
  effort,
  showSettings,
  onToggleSettings,
  onRouteChange,
  onEffortChange,
  onClear,
  hasMessages,
}: {
  status: AssistantStatus | null;
  connection: string;
  route: AssistantRoute;
  effort: Effort;
  showSettings: boolean;
  onToggleSettings: () => void;
  onRouteChange: (route: AssistantRoute) => void;
  onEffortChange: (effort: Effort) => void;
  onClear: () => void;
  hasMessages: boolean;
}) {
  return (
    <>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-slate-800/80 px-3">
        <Sparkles className="h-3.5 w-3.5 text-caret" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Assistant
        </span>
        {status?.model && (
          <span
            className="truncate rounded border border-purple-900/40 bg-purple-950/40 px-1.5 py-0.5 font-mono text-[9px] text-purple-300"
            title={status.remoteAvailable ? status.model : status.reason}
          >
            {status.model}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {hasMessages && (
            <button
              type="button"
              onClick={onClear}
              className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
              title="Clear conversation"
              aria-label="Clear conversation"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
          <button
            type="button"
            onClick={onToggleSettings}
            aria-expanded={showSettings}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
            title="Assistant settings"
          >
            <span className="font-mono uppercase">{route}</span>
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
                  Engine
                </legend>
                <div className="flex gap-1">
                  {ROUTES.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      title={option.hint}
                      onClick={() => onRouteChange(option.value)}
                      className={`flex-1 rounded border px-2 py-1 text-[10px] transition-colors ${
                        route === option.value
                          ? 'border-indigo-700/60 bg-indigo-950/60 text-indigo-200'
                          : 'border-slate-800 text-slate-400 hover:bg-slate-800/50'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
                  Effort
                </legend>
                <div className="flex gap-1">
                  {EFFORTS.map((level) => (
                    <button
                      key={level}
                      type="button"
                      onClick={() => onEffortChange(level)}
                      title={`Model reasoning effort: ${level}`}
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

              <p className="text-[10px] leading-relaxed text-slate-500">
                {connection === 'open'
                  ? status?.remoteAvailable
                    ? 'The local engine answers lookups instantly; the model handles the rest.'
                    : status?.available
                      ? `Local engine only. ${status.reason}`
                      : 'The assistant daemon is not running.'
                  : 'Connecting to the assistant…'}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function EmptyState({
  language,
  status,
  disabled,
  onPick,
}: {
  language: string;
  status: AssistantStatus | null;
  disabled: boolean;
  onPick: (prompt: string) => void;
}) {
  if (status && !status.available) {
    return (
      <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 p-3">
        <p className="text-xs leading-relaxed text-amber-200/90">
          The assistant daemon is not running.
        </p>
        <pre className="mt-2 overflow-x-auto rounded border border-slate-800 bg-obsidian p-2 font-mono text-[10px] text-slate-400">
          make assistant-daemon
        </pre>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="px-1 text-[11px] leading-relaxed text-slate-500">
        Ask about the code in your workspace. Lookups are answered instantly by the local
        index; anything that needs reasoning goes to the model.
      </p>
      {starterPrompts(language).map((prompt) => (
        <button
          key={prompt}
          type="button"
          disabled={disabled}
          onClick={() => onPick(prompt)}
          className="w-full rounded-lg border border-slate-800 bg-slate-900/40 px-2.5 py-2 text-left text-[11px] text-slate-400 transition-colors hover:border-indigo-800/50 hover:bg-indigo-950/30 hover:text-indigo-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {prompt}
        </button>
      ))}
    </div>
  );
}

function MessageBubble({
  message,
  streaming,
  onApplyCode,
}: {
  message: ChatMessage;
  streaming: boolean;
  onApplyCode: (code: string) => void;
}) {
  const [showThinking, setShowThinking] = useState(false);
  const isUser = message.role === 'user';

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-lg border p-2.5 ${
        isUser
          ? 'border-slate-800 bg-slate-900/50'
          : message.error
            ? 'border-rose-900/40 bg-rose-950/20'
            : 'border-indigo-900/30 bg-indigo-950/20'
      }`}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        {isUser ? (
          <User className="h-3 w-3 text-slate-500" aria-hidden />
        ) : (
          <Bot className="h-3 w-3 text-caret" aria-hidden />
        )}
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          {isUser ? 'You' : 'Assistant'}
        </span>

        {!isUser && message.engine && (
          <span
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] ${
              message.engine === 'local'
                ? 'bg-emerald-950/60 text-run'
                : 'bg-purple-950/60 text-purple-300'
            }`}
            title={
              message.engine === 'local'
                ? 'Answered from the workspace index, with no model call'
                : `Answered by ${message.model}`
            }
          >
            {message.engine === 'local' ? (
              <Zap className="h-2.5 w-2.5" aria-hidden />
            ) : (
              <BrainCircuit className="h-2.5 w-2.5" aria-hidden />
            )}
            {message.engine === 'local' ? 'local' : message.model}
          </span>
        )}

        {streaming && (
          <Loader2 className="ml-auto h-3 w-3 animate-spin text-slate-600" aria-hidden />
        )}
        {!streaming && message.elapsedMs !== undefined && (
          <span className="ml-auto font-mono text-[9px] text-slate-600">
            {message.elapsedMs}ms
            {message.costCents ? ` · ${message.costCents.toFixed(3)}¢` : ''}
          </span>
        )}
      </div>

      {message.thinking && (
        <div className="mb-1.5">
          <button
            type="button"
            onClick={() => setShowThinking((value) => !value)}
            className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300"
          >
            <ChevronDown
              className={`h-2.5 w-2.5 transition-transform ${showThinking ? 'rotate-180' : ''}`}
              aria-hidden
            />
            Reasoning
          </button>
          {showThinking && (
            <p className="mt-1 border-l border-slate-800 pl-2 text-[10px] italic leading-relaxed text-slate-500">
              {message.thinking}
            </p>
          )}
        </div>
      )}

      <MessageBody content={message.content} onApplyCode={onApplyCode} />

      {streaming && message.content.length === 0 && !message.thinking && (
        <p className="text-[11px] italic text-slate-600">Thinking…</p>
      )}
    </motion.div>
  );
}

/**
 * Render a reply, splitting fenced code blocks out of the prose.
 *
 * Full Markdown is deliberately not parsed: code blocks are what the user acts
 * on, and everything else reads fine as plain text with preserved newlines.
 */
function MessageBody({
  content,
  onApplyCode,
}: {
  content: string;
  onApplyCode: (code: string) => void;
}) {
  const segments = useMemo(() => splitFencedBlocks(content), [content]);

  return (
    <div className="space-y-1.5">
      {segments.map((segment, index) =>
        segment.kind === 'code' ? (
          <CodeBlock
            key={index}
            language={segment.language}
            code={segment.text}
            onApply={onApplyCode}
          />
        ) : (
          <p
            key={index}
            className="whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-slate-300"
          >
            {segment.text}
          </p>
        ),
      )}
    </div>
  );
}

interface Segment {
  kind: 'text' | 'code';
  text: string;
  language: string;
}

export function splitFencedBlocks(content: string): Segment[] {
  const segments: Segment[] = [];
  const lines = content.split('\n');

  let inCode = false;
  let language = '';
  let buffer: string[] = [];

  const flush = (kind: 'text' | 'code') => {
    const text = kind === 'code' ? buffer.join('\n') : buffer.join('\n').trim();
    if (text.length > 0) segments.push({ kind, text, language });
    buffer = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        flush('code');
        inCode = false;
        language = '';
      } else {
        flush('text');
        inCode = true;
        language = line.trim().slice(3).trim();
      }
      continue;
    }
    buffer.push(line);
  }
  // A stream that is still arriving leaves the final fence unclosed; render
  // what has arrived so far rather than dropping it.
  flush(inCode ? 'code' : 'text');

  return segments;
}

function CodeBlock({
  language,
  code,
  onApply,
}: {
  language: string;
  code: string;
  onApply: (code: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="overflow-hidden rounded border border-slate-800 bg-obsidian">
      <div className="flex items-center justify-between border-b border-slate-800 px-2 py-1">
        <span className="font-mono text-[9px] uppercase tracking-wide text-slate-500">
          {language || 'code'}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(code).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              });
            }}
            className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
            title="Copy"
            aria-label="Copy code"
          >
            <Copy className="h-3 w-3" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => onApply(code)}
            className="rounded px-1.5 py-0.5 text-[9px] text-slate-400 hover:bg-slate-800 hover:text-run"
            title="Replace the active file with this code"
          >
            {copied ? 'copied' : 'apply'}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto p-2 font-mono text-[10.5px] leading-relaxed text-slate-300">
        {code}
      </pre>
    </div>
  );
}

function Composer({
  value,
  disabled,
  streaming,
  hasSelection,
  inputRef,
  onChange,
  onSend,
}: {
  value: string;
  disabled: boolean;
  streaming: boolean;
  hasSelection: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onSend: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-slate-800/80 p-2">
      {hasSelection && (
        <p className="mb-1 px-1 text-[9px] text-slate-500">
          Your selection is included with the question.
        </p>
      )}
      <div className="flex items-end gap-1.5">
        <textarea
          ref={inputRef}
          rows={2}
          value={value}
          disabled={disabled}
          placeholder={disabled ? 'Assistant unavailable' : 'Ask about your code…'}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter is a newline, as in every chat box.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          aria-label="Message the assistant"
          className="min-h-[42px] flex-1 resize-none rounded-lg border border-slate-800 bg-slate-900/60 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-slate-200 outline-none transition-colors placeholder:text-slate-600 focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={disabled || streaming || value.trim().length === 0}
          aria-label="Send"
          className="flex h-[42px] w-9 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-600 to-purple-600 text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-600"
        >
          {streaming ? (
            <Square className="h-3 w-3 fill-current" aria-hidden />
          ) : (
            <CornerDownLeft className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
      </div>
    </div>
  );
}
