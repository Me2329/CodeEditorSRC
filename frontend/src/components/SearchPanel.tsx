/**
 * Search and replace across the workspace.
 *
 * Results are grouped by file and each one jumps the editor to that line. The
 * replace half is deliberately two steps: type a replacement, see how many
 * files it touches, then confirm. A replace-all that fires on Enter is how
 * people lose an afternoon.
 */

import { CaseSensitive, ChevronDown, ChevronRight, Regex, Replace, WholeWord } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  DEFAULT_OPTIONS,
  type SearchOptions,
  countMatches,
  replaceInWorkspace,
  searchWorkspace,
} from '../lib/search';
import type { VirtualFile } from '../lib/types';

interface Props {
  files: readonly VirtualFile[];
  onOpen: (fileId: string, line: number) => void;
  onReplace: (changes: { fileId: string; name: string; content: string }[]) => void;
  /** A search asked for from somewhere else, such as the name under the caret.
   *  Changing it replaces what is typed here; the object identity is what says
   *  "this is a new request" rather than the text, so asking twice for the same
   *  name works. */
  request?: { query: string; options?: Partial<SearchOptions> } | null;
}

export function SearchPanel({ files, onOpen, onReplace, request }: Props) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_OPTIONS);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showReplace, setShowReplace] = useState(false);

  const results = useMemo(
    () => searchWorkspace(files, query, options),
    [files, query, options],
  );
  const total = countMatches(results);

  // Computed rather than applied, so the count is visible before committing.
  const pending = useMemo(
    () => (showReplace && query ? replaceInWorkspace(files, query, replacement, options) : []),
    [showReplace, files, query, replacement, options],
  );

  useEffect(() => {
    if (!request) return;
    setQuery(request.query);
    setOptions({ ...DEFAULT_OPTIONS, ...request.options });
    // Someone else asked for this search; a replacement left over from the
    // last one is not part of the question.
    setShowReplace(false);
  }, [request]);

  const toggle = (key: keyof SearchOptions) =>
    setOptions((current) => ({ ...current, [key]: !current[key] }));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 space-y-1.5 border-b border-slate-800/80 p-2">
        <div className="flex items-center gap-1.5">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the workspace"
            aria-label="Search the workspace"
            className="min-w-0 flex-1 rounded border border-slate-700 bg-obsidian px-2 py-1 font-mono text-[11px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-indigo-500"
          />
          <OptionButton
            active={options.caseSensitive}
            icon={CaseSensitive}
            title="Match case"
            onClick={() => toggle('caseSensitive')}
          />
          <OptionButton
            active={options.wholeWord}
            icon={WholeWord}
            title="Whole word"
            onClick={() => toggle('wholeWord')}
          />
          <OptionButton
            active={options.regex}
            icon={Regex}
            title="Regular expression"
            onClick={() => toggle('regex')}
          />
          <OptionButton
            active={showReplace}
            icon={Replace}
            title="Replace"
            onClick={() => setShowReplace((current) => !current)}
          />
        </div>

        {showReplace && (
          <div className="flex items-center gap-1.5">
            <input
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              placeholder={options.regex ? 'Replace with ($1 for groups)' : 'Replace with'}
              aria-label="Replace with"
              className="min-w-0 flex-1 rounded border border-slate-700 bg-obsidian px-2 py-1 font-mono text-[11px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-indigo-500"
            />
            <button
              type="button"
              disabled={pending.length === 0}
              onClick={() => {
                onReplace(pending);
                setShowReplace(false);
              }}
              className="shrink-0 rounded border border-slate-700 px-2 py-1 text-[10px] text-slate-300 transition-colors enabled:hover:border-indigo-500 enabled:hover:text-indigo-300 disabled:opacity-40"
            >
              {pending.length === 0
                ? 'No files'
                : `Replace in ${pending.length} ${pending.length === 1 ? 'file' : 'files'}`}
            </button>
          </div>
        )}

        <p className="font-mono text-[10px] text-slate-500">
          {!query
            ? 'Type to search.'
            : total === 0
              ? 'No matches.'
              : `${total} ${total === 1 ? 'match' : 'matches'} in ${results.length} ${
                  results.length === 1 ? 'file' : 'files'
                }`}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {results.map((group) => {
          const isCollapsed = collapsed.has(group.fileId);
          return (
            <div key={group.fileId}>
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
                className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] text-slate-300 hover:bg-slate-800/40"
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3 w-3 shrink-0 text-slate-600" aria-hidden />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0 text-slate-600" aria-hidden />
                )}
                <span className="truncate font-mono">{group.fileName}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-600">
                  {group.matches.length}
                </span>
              </button>

              {!isCollapsed &&
                group.matches.map((match, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => onOpen(match.fileId, match.line)}
                    className="flex w-full items-baseline gap-2 px-2 py-0.5 pl-6 text-left font-mono text-[11px] hover:bg-slate-800/40"
                  >
                    <span className="w-8 shrink-0 text-right text-slate-600">{match.line}</span>
                    <span className="truncate text-slate-400">
                      {match.text.slice(0, match.start)}
                      <mark className="bg-indigo-500/30 text-indigo-200">
                        {match.text.slice(match.start, match.end)}
                      </mark>
                      {match.text.slice(match.end)}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OptionButton({
  active,
  icon: Icon,
  title,
  onClick,
}: {
  active: boolean;
  icon: typeof Regex;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`shrink-0 rounded border p-1 transition-colors ${
        active
          ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-300'
          : 'border-slate-700 text-slate-500 hover:text-slate-300'
      }`}
    >
      <Icon className="h-3 w-3" aria-hidden />
    </button>
  );
}
