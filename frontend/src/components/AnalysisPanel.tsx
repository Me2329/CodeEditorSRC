/**
 * Static analysis panel: scope tree, metrics and diagnostics from the C++
 * analyzer. Clicking a node or a diagnostic jumps the editor to that line.
 */

import { AlertTriangle, ChevronRight, Info, XCircle } from 'lucide-react';
import { useState } from 'react';

import type { AnalysisResult, AstNode, Diagnostic } from '../lib/types';

interface Props {
  analysis: AnalysisResult | null;
  error: string | null;
  pending: boolean;
  onJumpToLine: (line: number) => void;
}

export function AnalysisPanel({ analysis, error, pending, onJumpToLine }: Props) {
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
        <p className="text-xs text-slate-500">
          {pending ? 'Analyzing…' : 'Start typing to see the structure of your code.'}
        </p>
      </PanelShell>
    );
  }

  const { metrics, diagnostics, ast } = analysis;

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
        <section className="mt-4">
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Diagnostics ({diagnostics.length})
          </h3>
          <ul className="space-y-1">
            {diagnostics.slice(0, 40).map((diagnostic, index) => (
              <DiagnosticRow
                key={`${diagnostic.rule}-${diagnostic.line}-${index}`}
                diagnostic={diagnostic}
                onJump={onJumpToLine}
              />
            ))}
          </ul>
        </section>
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

      {ast && ast.children.length === 0 && diagnostics.length === 0 && (
        <p className="mt-4 text-xs text-slate-500">No declarations found in this file.</p>
      )}
    </PanelShell>
  );
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>;
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
