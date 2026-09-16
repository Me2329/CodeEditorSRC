/**
 * Renaming a name across the workspace, with the proposal shown first.
 *
 * The index matches names and nothing more, so this cannot know that two
 * `save`s are the same `save`. Rather than pretend, it shows every occurrence
 * it found, says what each one is part of, and renames exactly what is ticked.
 * Code is ticked to begin with; comments and strings are not, because a name in
 * prose is usually a mention rather than a use — and occasionally is precisely
 * what you meant to change, which is why it is listed at all.
 *
 * Opened over the editor rather than in a side panel: it is modal work, it ends
 * in a decision, and leaving it half-done in a tab nobody looks at is worse
 * than closing it.
 */

import { ChevronDown, ChevronRight, MessageSquare, Quote, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  type RenameEdit,
  type RenameSite,
  SITE_LIMIT,
  applyRename,
  countByRegion,
  defaultSelection,
  keyOf,
  planRename,
  whyNot,
} from '../lib/rename';
import type { VirtualFile } from '../lib/types';

interface Props {
  files: readonly VirtualFile[];
  /** The name under the caret when the panel was asked for. */
  name: string;
  /** The language of the file the caret was in, which decides what is reserved. */
  language: string;
  onApply: (edits: RenameEdit[], replacement: string) => void;
  onClose: () => void;
}

export function RenamePanel({ files, name, language, onApply, onClose }: Props) {
  const [replacement, setReplacement] = useState(name);
  // Computed once, when the panel opens. An effect keyed on `files` would look
  // equivalent and would not be: anything that edits the workspace while the
  // panel is up — an agent edit, a restore — would re-run it and silently throw
  // away every box the reader had ticked.
  const [selection, setSelection] = useState<Set<string>>(() =>
    defaultSelection(planRename(files, name, name)),
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);

  const plan = useMemo(() => planRename(files, name, replacement), [files, name, replacement]);
  const counts = countByRegion(plan.sites);
  const problem = whyNot(name, replacement, language);
  // The panel opens with the old name in the box, so "that is already the
  // name" is the state it starts in rather than a mistake to report. Saying it
  // there would replace the count — the one thing the panel exists to show —
  // with a scolding for not having typed yet.
  const untouched = replacement === name;

  useEffect(() => {
    input.current?.select();
  }, []);

  const chosen = plan.sites.filter((site) => selection.has(keyOf(site))).length;

  const toggleSite = (site: RenameSite) =>
    setSelection((current) => {
      const next = new Set(current);
      const key = keyOf(site);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleFile = (sites: readonly RenameSite[]) =>
    setSelection((current) => {
      const next = new Set(current);
      const every = sites.every((site) => next.has(keyOf(site)));
      for (const site of sites) {
        if (every) next.delete(keyOf(site));
        else next.add(keyOf(site));
      }
      return next;
    });

  const commit = () => {
    if (problem || chosen === 0) return;
    onApply(applyRename(files, plan, selection), replacement);
  };

  return (
    <div
      className="absolute inset-0 z-30 flex items-start justify-center bg-slate-950/60 p-8"
      role="dialog"
      aria-modal="true"
      aria-label={`Rename ${name}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 p-3">
          <span className="shrink-0 font-mono text-[11px] text-slate-500">Rename</span>
          <span className="shrink-0 font-mono text-[11px] text-slate-300">{name}</span>
          <span className="shrink-0 font-mono text-[11px] text-slate-600">to</span>
          <input
            ref={input}
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
            }}
            aria-label="New name"
            className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-indigo-500"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded p-1 text-slate-500 hover:text-slate-300"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>

        <div className="shrink-0 border-b border-slate-800 px-3 py-2">
          <p className="font-mono text-[10px] text-slate-500">
            {(untouched ? null : problem) ??
              (plan.sites.length === 0
                ? `No occurrence of ${name} in this workspace.`
                : `${chosen} of ${plan.sites.length} selected, in ${plan.files.length} ${
                    plan.files.length === 1 ? 'file' : 'files'
                  }`)}
          </p>
          {plan.sites.length > 0 && (counts.comment > 0 || counts.string > 0) && (
            <p className="mt-1 font-mono text-[10px] text-amber-500/80">
              {[
                counts.comment > 0 ? `${counts.comment} in comments` : '',
                counts.string > 0 ? `${counts.string} in strings` : '',
              ]
                .filter(Boolean)
                .join(', ')}
              , left unticked. There is no language server here, so these are
              occurrences of the spelling rather than uses of the thing.
            </p>
          )}
          {plan.sites.length >= SITE_LIMIT && (
            <p className="mt-1 font-mono text-[10px] text-amber-500/80">
              Stopped at {SITE_LIMIT}. Too many to review is too many to rename.
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {plan.files.map((group) => {
            const isCollapsed = collapsed.has(group.fileId);
            const picked = group.sites.filter((site) => selection.has(keyOf(site))).length;
            return (
              <div key={group.fileId}>
                <div className="flex items-center gap-1 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800/40">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(group.fileId)) next.delete(group.fileId);
                        else next.add(group.fileId);
                        return next;
                      })
                    }
                    aria-label={isCollapsed ? `Expand ${group.fileName}` : `Collapse ${group.fileName}`}
                    className="shrink-0 text-slate-600 hover:text-slate-400"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3 w-3" aria-hidden />
                    ) : (
                      <ChevronDown className="h-3 w-3" aria-hidden />
                    )}
                  </button>
                  <input
                    type="checkbox"
                    checked={picked === group.sites.length}
                    ref={(node) => {
                      if (node) node.indeterminate = picked > 0 && picked < group.sites.length;
                    }}
                    onChange={() => toggleFile(group.sites)}
                    aria-label={`Select every occurrence in ${group.fileName}`}
                    className="h-3 w-3 shrink-0 accent-indigo-500"
                  />
                  <span className="truncate font-mono">{group.fileName}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-600">
                    {picked}/{group.sites.length}
                  </span>
                </div>

                {!isCollapsed &&
                  group.sites.map((site) => (
                    <label
                      key={keyOf(site)}
                      className="flex w-full cursor-pointer items-baseline gap-2 px-2 py-0.5 pl-8 text-left font-mono text-[11px] hover:bg-slate-800/40"
                    >
                      <input
                        type="checkbox"
                        checked={selection.has(keyOf(site))}
                        onChange={() => toggleSite(site)}
                        className="h-3 w-3 shrink-0 self-center accent-indigo-500"
                      />
                      <span className="w-8 shrink-0 text-right text-slate-600">{site.line}</span>
                      {site.region === 'comment' && (
                        <MessageSquare
                          className="h-3 w-3 shrink-0 self-center text-amber-600"
                          aria-label="in a comment"
                        />
                      )}
                      {site.region === 'string' && (
                        <Quote
                          className="h-3 w-3 shrink-0 self-center text-emerald-600"
                          aria-label="in a string"
                        />
                      )}
                      <span className="truncate text-slate-400">
                        {site.text.slice(0, site.column - 1)}
                        <mark className="bg-indigo-500/30 text-indigo-200">{name}</mark>
                        {site.text.slice(site.column - 1 + name.length)}
                      </span>
                    </label>
                  ))}
              </div>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-800 p-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-700 px-3 py-1 font-mono text-[11px] text-slate-400 hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commit}
            disabled={Boolean(problem) || chosen === 0}
            className="rounded border border-indigo-500/50 bg-indigo-500/15 px-3 py-1 font-mono text-[11px] text-indigo-300 disabled:opacity-40 disabled:hover:text-indigo-300"
          >
            {chosen === 0 ? 'Nothing selected' : `Rename ${chosen}`}
          </button>
        </div>
      </div>
    </div>
  );
}
