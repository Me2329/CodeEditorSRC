/**
 * Static analysis panel: scope tree, metrics and diagnostics from the C++
 * analyzer. Clicking a node or a diagnostic jumps the editor to that line.
 */

import { AlertTriangle, ChevronRight, Info, XCircle } from 'lucide-react';
import { useState } from 'react';

import type { Todo } from '../lib/todos';
import type { AnalysisResult, AstNode, Diagnostic } from '../lib/types';

interface Props {
  analysis: AnalysisResult | null;
  error: string | null;
  pending: boolean;
  /**
   * Diagnostics from enabled extensions, shown alongside the analyzer's.
   *
   * Separate from `analysis` because they have different lifetimes: these
   * recompute on every keystroke, the analyzer's arrive when it answers.
   */
  extensionDiagnostics?: readonly Diagnostic[];
  /**
   * TODO and FIXME notes from every file, not only this one.
   *
   * Shown here because this panel already answers "what is wrong with the
   * code", and a note somebody left for themselves is the part of that the
   * analyzer cannot see.
   */
  todos?: readonly Todo[];
  onJumpToLine: (line: number) => void;
  onOpenTodo?: (fileId: string, line: number) => void;
}

export function AnalysisPanel({
  analysis,
  error,
  pending,
  extensionDiagnostics = [],
  todos = [],
  onJumpToLine,
  onOpenTodo,
}: Props) {
  if (error) {
    return (
      <PanelShell>
        <p className="text-xs leading-relaxed text-amber-300/90">{error}</p>
      </PanelShell>
    );
  }

  if (!analysis) {
    return (
      <PanelShell>
        {extensionDiagnostics.length > 0 && (
          <DiagnosticList diagnostics={extensionDiagnostics} onJump={onJumpToLine} />
        )}
        <p className="text-xs text-slate-500">
          {pending ? 'Analyzing…' : 'Start typing to see the structure of your code.'}
        </p>
        <TodoList todos={todos} onOpen={onOpenTodo} />
      </PanelShell>
    );
  }

  const { metrics, ast } = analysis;
  // Analyzer findings first: a parse error is more urgent than a long line.
  const diagnostics = [...analysis.diagnostics, ...extensionDiagnostics];

  return (
    <PanelShell>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[11px]">
        <Metric label="Code lines" value={metrics.code_lines} />
        <Metric label="Comments" value={metrics.comment_lines} />
        <Metric label="Declarations" value={metrics.declarations} />
        <Metric label="Tokens" value={metrics.tokens} />
        <Metric
          label="Complexity"
          value={metrics.cyclomatic_complexity}
          warn={metrics.cyclomatic_complexity > 20}
        />
        <Metric
          label="Max nesting"
          value={metrics.max_nesting_depth}
          warn={metrics.max_nesting_depth > 6}
        />
      </dl>

      {diagnostics.length > 0 && (
        <DiagnosticList diagnostics={diagnostics} onJump={onJumpToLine} />
      )}

      {ast && ast.children.length > 0 && (
        <section className="mt-4">
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Structure
          </h3>
          <ul className="space-y-0.5">
            {ast.children.map((child, index) => (
              <TreeNode
                key={`${child.name}-${child.line}-${index}`}
                node={child}
                depth={0}
                onJump={onJumpToLine}
              />
            ))}
          </ul>
        </section>
      )}

      <TodoList todos={todos} onOpen={onOpenTodo} />

      {ast && ast.children.length === 0 && diagnostics.length === 0 && (
        <p className="mt-4 text-xs text-slate-500">No declarations found in this file.</p>
      )}
    </PanelShell>
  );
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>;
}

/** Notes left in comments, across the whole workspace. */
function TodoList({
  todos,
  onOpen,
}: {
  todos: readonly Todo[];
  onOpen?: (fileId: string, line: number) => void;
}) {
  if (todos.length === 0) return null;

  return (
    <section className="mt-4">
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        Notes in comments ({todos.length})
      </h3>
      <ul className="space-y-0.5">
        {todos.map((todo) => (
          <li key={`${todo.fileId}:${todo.line}:${todo.kind}`}>
            <button
              type="button"
              onClick={() => onOpen?.(todo.fileId, todo.line)}
              className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-[11px] text-slate-400 transition-colors hover:bg-slate-800/40 hover:text-slate-200"
            >
              <span
                className={`shrink-0 font-mono text-[9px] uppercase ${
                  todo.kind === 'FIXME' || todo.kind === 'BUG'
                    ? 'text-halt'
                    : todo.kind === 'NOTE'
                      ? 'text-slate-600'
                      : 'text-amber-400/80'
                }`}
              >
                {todo.kind}
              </span>
              <span className="min-w-0 flex-1 truncate">{todo.text || '(no note)'}</span>
              <span className="shrink-0 font-mono text-[9px] text-slate-600">
                {todo.fileName}:{todo.line}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Metric({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-slate-800/60 pb-1">
      <dt className="truncate text-slate-500">{label}</dt>
      <dd className={warn ? 'font-semibold text-amber-400' : 'text-slate-200'}>{value}</dd>
    </div>
  );
}

const SEVERITY_STYLES = {
  error: { icon: XCircle, className: 'text-halt' },
  warning: { icon: AlertTriangle, className: 'text-amber-400' },
  info: { icon: Info, className: 'text-sky-400' },
} as const;

/** Diagnostics, capped so a file full of findings stays scrollable. */
function DiagnosticList({
  diagnostics,
  onJump,
}: {
  diagnostics: readonly Diagnostic[];
  onJump: (line: number) => void;
}) {
  const shown = diagnostics.slice(0, 40);

  return (
    <section className="mt-4">
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        Diagnostics ({diagnostics.length})
      </h3>
      <ul className="space-y-1">
        {shown.map((diagnostic, index) => (
          <DiagnosticRow
            key={`${diagnostic.rule}-${diagnostic.line}-${index}`}
            diagnostic={diagnostic}
            onJump={onJump}
          />
        ))}
      </ul>
      {diagnostics.length > shown.length && (
        <p className="mt-1 text-[10px] text-slate-600">
          and {diagnostics.length - shown.length} more
        </p>
      )}
    </section>
  );
}

function DiagnosticRow({
  diagnostic,
  onJump,
}: {
  diagnostic: Diagnostic;
  onJump: (line: number) => void;
}) {
  const style = SEVERITY_STYLES[diagnostic.severity] ?? SEVERITY_STYLES.info;
  const Icon = style.icon;
  return (
    <li>
      <button
        type="button"
        onClick={() => onJump(diagnostic.line)}
        className="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-slate-800/50"
      >
        <Icon className={`mt-0.5 h-3 w-3 shrink-0 ${style.className}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] leading-snug text-slate-300">
            {diagnostic.message}
          </span>
          <span className="font-mono text-[10px] text-slate-600">
            line {diagnostic.line} · {diagnostic.rule}
          </span>
        </span>
      </button>
    </li>
  );
}

function TreeNode({
  node,
  depth,
  onJump,
}: {
  node: AstNode;
  depth: number;
  onJump: (line: number) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children.length > 0;

  return (
    <li>
      <div
        className="flex items-center gap-1 rounded hover:bg-slate-800/50"
        style={{ paddingLeft: `${depth * 10}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded((previous) => !previous)}
            aria-label={expanded ? 'Collapse' : 'Expand'}
            className="shrink-0 rounded p-0.5 text-slate-600 hover:text-slate-300"
          >
            <ChevronRight
              className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
              aria-hidden
            />
          </button>
        ) : (
          <span className="w-4 shrink-0" aria-hidden />
        )}
        <button
          type="button"
          onClick={() => onJump(node.line)}
          className="flex min-w-0 flex-1 items-baseline gap-1.5 py-0.5 text-left font-mono text-[11px]"
          title={node.detail}
        >
          <span className="truncate text-indigo-300">{node.name || node.kind}</span>
          <span className="shrink-0 text-[9px] uppercase tracking-wide text-slate-600">
            {node.kind === 'TypeDeclaration' ? 'type' : 'fn'}
          </span>
          <span className="ml-auto shrink-0 text-[10px] text-slate-600">{node.line}</span>
        </button>
      </div>
      {hasChildren && expanded && (
        <ul className="space-y-0.5">
          {node.children.map((child, index) => (
            <TreeNode
              key={`${child.name}-${child.line}-${index}`}
              node={child}
              depth={depth + 1}
              onJump={onJump}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
