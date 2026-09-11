/**
 * Review a change before accepting it.
 *
 * Shown when the agent rewrites a file: seeing what changed is the difference
 * between trusting a diff and trusting a promise. Long runs of unchanged lines
 * are collapsed, because a one-line change in a thousand-line file is
 * unreadable otherwise.
 */

import { Check, Copy, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { collapse, diffLines, diffStats, toUnified } from '../lib/diff';

interface Props {
  name: string;
  before: string;
  after: string;
  onAccept?: () => void;
  onReject?: () => void;
  /** Dismiss the view without judging the change, for a comparison rather than
   *  a proposal. */
  onClose?: () => void;
}

export function DiffView({ name, before, after, onAccept, onReject, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  const { hunks, stats, unified } = useMemo(() => {
    const lines = diffLines(before, after);
    return { hunks: collapse(lines, 3), stats: diffStats(lines), unified: toUnified(lines, name) };
  }, [before, after, name]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(unified);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the diff is still on screen to read.
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-slate-800/80 px-3 text-[11px]">
        <span className="truncate font-mono text-slate-300">{name}</span>

        <span className="flex shrink-0 items-center gap-2 font-mono text-[10px]">
          <span className="text-run">+{stats.added}</span>
          <span className="text-halt">-{stats.removed}</span>
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={copy}
            title="Copy as a unified diff"
            className="flex items-center gap-1 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200"
          >
            <Copy className="h-3 w-3" aria-hidden />
            {copied ? 'Copied' : 'Copy'}
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="flex items-center gap-1 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200"
            >
              <X className="h-3 w-3" aria-hidden />
              Close
            </button>
          )}
          {onReject && (
            <button
              type="button"
              onClick={onReject}
              className="flex items-center gap-1 rounded border border-rose-800/50 bg-rose-950/40 px-1.5 py-0.5 text-[10px] text-halt transition-colors hover:bg-rose-950/70"
            >
              <X className="h-3 w-3" aria-hidden />
              Discard
            </button>
          )}
          {onAccept && (
            <button
              type="button"
              onClick={onAccept}
              className="flex items-center gap-1 rounded border border-emerald-800/50 bg-emerald-950/40 px-1.5 py-0.5 text-[10px] text-run transition-colors hover:bg-emerald-950/70"
            >
              <Check className="h-3 w-3" aria-hidden />
              Keep
            </button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-[1.5]">
        {hunks.length === 0 ? (
          <p className="p-3 text-slate-500">No changes.</p>
        ) : (
          hunks.map((hunk, index) => (
            <div key={index}>
              {hunk.skipped > 0 && (
                <div className="border-y border-slate-800/60 bg-charcoal/60 px-3 py-0.5 text-[10px] text-slate-600">
                  {hunk.skipped} unchanged {hunk.skipped === 1 ? 'line' : 'lines'}
                </div>
              )}
              {hunk.lines.map((line, lineIndex) => (
                <div
                  key={lineIndex}
                  className={`flex whitespace-pre ${
                    line.kind === 'added'
                      ? 'bg-emerald-950/30 text-emerald-200'
                      : line.kind === 'removed'
                        ? 'bg-rose-950/30 text-rose-200'
                        : 'text-slate-400'
                  }`}
                >
                  <span className="w-10 shrink-0 select-none px-1 text-right text-slate-600">
                    {line.beforeLine ?? ''}
                  </span>
                  <span className="w-10 shrink-0 select-none px-1 text-right text-slate-600">
                    {line.afterLine ?? ''}
                  </span>
                  <span className="w-4 shrink-0 select-none text-slate-600">
                    {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
                  </span>
                  <span className="pr-3">{line.text || ' '}</span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
