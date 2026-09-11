/**
 * What this file looked like before.
 *
 * A list of snapshots for the file on screen, each one diffed against what is
 * in the buffer now. Selecting a revision shows the change; restoring it takes
 * a snapshot of the current content first, so restoring the wrong one is
 * itself undoable.
 */

import { History as HistoryIcon, RotateCcw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { collapse, diffLines, diffStats } from '../lib/diff';
import { type History, describeAge, describeReason, revisionsFor } from '../lib/history';
import type { VirtualFile } from '../lib/types';

interface Props {
  history: History;
  file: VirtualFile | null;
  onRestore: (fileId: string, content: string) => void;
  onForget: (fileId: string) => void;
}

export function HistoryPanel({ history, file, onRestore, onForget }: Props) {
  const [selected, setSelected] = useState<string | null>(null);

  const revisions = file ? revisionsFor(history, file.id) : [];
  // Recomputed rather than remembered: a revision selected in one file must not
  // stay selected when the user switches to another.
  const active = revisions.find((revision) => revision.id === selected) ?? null;

  const now = Date.now();

  const change = useMemo(() => {
    if (!active || !file) return null;
    const lines = diffLines(active.content, file.content);
    return { hunks: collapse(lines, 2), stats: diffStats(lines) };
  }, [active, file]);

  if (!file) {
    return <Empty>Open a file to see its history.</Empty>;
  }

  if (revisions.length === 0) {
    return (
      <Empty>
        No snapshots of {file.name} yet. One is taken when you pause after editing, before a
        run, and before anything rewrites the file for you.
      </Empty>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-slate-800/80 px-3">
        <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <HistoryIcon className="h-3 w-3" aria-hidden />
          {revisions.length} {revisions.length === 1 ? 'snapshot' : 'snapshots'}
        </span>
        <button
          type="button"
          onClick={() => {
            onForget(file.id);
            setSelected(null);
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-500 transition-colors hover:bg-slate-800/60 hover:text-slate-300"
          title="Discard every snapshot of this file"
        >
          <Trash2 className="h-3 w-3" aria-hidden />
          clear
        </button>
      </header>

      <ul className="max-h-48 shrink-0 overflow-y-auto border-b border-slate-800/80">
        {revisions.map((revision) => {
          const isActive = revision.id === active?.id;
          return (
            <li key={revision.id}>
              <button
                type="button"
                onClick={() => setSelected(isActive ? null : revision.id)}
                aria-pressed={isActive}
                className={`flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-[11px] transition-colors ${
                  isActive
                    ? 'bg-accent/10 text-slate-200'
                    : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
                }`}
              >
                <span className="truncate">{describeReason(revision.reason)}</span>
                <span className="shrink-0 font-mono text-[10px] text-slate-500">
                  {describeAge(revision.at, now)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {active && change && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-slate-800/80 px-3">
            <span className="font-mono text-[10px]">
              <span className="text-run">+{change.stats.added}</span>{' '}
              <span className="text-halt">-{change.stats.removed}</span>
              <span className="ml-2 text-slate-600">against the buffer now</span>
            </span>
            <button
              type="button"
              onClick={() => onRestore(file.id, active.content)}
              disabled={change.stats.added === 0 && change.stats.removed === 0}
              className="flex items-center gap-1 rounded bg-accent/15 px-2 py-0.5 text-[10px] text-accent transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:bg-slate-800/40 disabled:text-slate-600"
              title="Put this content back; the current content is snapshotted first"
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
              restore
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-[1.45]">
            {change.stats.added === 0 && change.stats.removed === 0 ? (
              <p className="px-3 py-2 text-slate-500">Identical to what is open now.</p>
            ) : (
              change.hunks.map((hunk, index) => (
                <div key={index} className="border-b border-slate-800/40 last:border-0">
                  {hunk.lines.map((line, lineIndex) => (
                    <div
                      key={lineIndex}
                      className={`flex gap-2 px-3 ${
                        line.kind === 'added'
                          ? 'bg-run/10 text-run'
                          : line.kind === 'removed'
                            ? 'bg-halt/10 text-halt'
                            : 'text-slate-500'
                      }`}
                    >
                      <span className="w-3 shrink-0 select-none text-slate-600">
                        {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
                      </span>
                      <span className="whitespace-pre-wrap break-all">{line.text || ' '}</span>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-3 text-[11px] leading-relaxed text-slate-500">{children}</div>
  );
}
