/**
 * The declarations in the file on screen, in the order they appear in it.
 *
 * The file tree above answers "which file", and this answers "where in it".
 * Methods sit under their class, the declaration the caret is inside is lit up,
 * and clicking one moves the caret there.
 *
 * The symbols come from the assistant daemon's workspace index, so this is
 * empty when it is not running. That is said plainly rather than shown as an
 * empty list, because a file with no functions in it looks the same.
 */

import { ListTree } from 'lucide-react';
import { useMemo, useState } from 'react';

import { type OutlineEntry, enclosing, filterOutline, outlineFor } from '../lib/outline';
import type { Symbol as WorkspaceSymbol } from '../lib/types';

interface Props {
  symbols: WorkspaceSymbol[];
  /** The file on screen. Its declarations are the ones shown. */
  fileName: string;
  /** Where the caret is, so the declaration around it can be marked. */
  line: number;
  /** True while the daemon that supplies symbols is unreachable. */
  unavailable?: boolean;
  onJump: (line: number) => void;
}

/** One letter per kind, because 224 pixels is not enough for the word. */
const INITIALS: Record<string, string> = {
  class: 'C',
  struct: 'S',
  enum: 'E',
  interface: 'I',
  trait: 'T',
  impl: 'I',
  module: 'M',
  object: 'O',
  constant: 'K',
  variable: 'V',
  type: 'T',
  function: 'ƒ',
};

const TONES: Record<string, string> = {
  class: 'text-caret',
  struct: 'text-caret',
  enum: 'text-caret',
  interface: 'text-accent',
  trait: 'text-accent',
  impl: 'text-accent',
  module: 'text-accent',
  function: 'text-run',
};

export function OutlinePanel({ symbols, fileName, line, unavailable, onJump }: Props) {
  const [query, setQuery] = useState('');

  const entries = useMemo(() => outlineFor(symbols, fileName), [symbols, fileName]);
  const shown = useMemo(() => filterOutline(entries, query), [entries, query]);
  // Against the unfiltered list: the declaration the caret is in does not stop
  // being that because it was typed out of the list.
  const current = entries[enclosing(entries, line)] ?? null;

  return (
    <section className="flex h-[38%] min-h-0 flex-col border-t border-slate-800/80">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-slate-800/80 px-3">
        <ListTree className="h-3.5 w-3.5 text-caret" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Outline
        </span>
        {entries.length > 0 && (
          <span className="ml-auto font-mono text-[10px] text-slate-600">{entries.length}</span>
        )}
      </header>

      {entries.length > 4 && (
        <div className="shrink-0 px-2 pt-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter…"
            aria-label="Filter the outline"
            className="w-full rounded border border-slate-800 bg-obsidian px-2 py-1 font-mono text-[11px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-accent"
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-[11px]">
        {entries.length === 0 ? (
          <p className="px-1 py-2 leading-snug text-slate-600">
            {unavailable
              ? 'The assistant daemon is not running, so nothing is indexed.'
              : fileName
                ? 'Nothing declared in this file.'
                : 'No file open.'}
          </p>
        ) : shown.length === 0 ? (
          <p className="px-1 py-2 text-slate-600">Nothing matches.</p>
        ) : (
          shown.map((entry) => (
            <Row
              key={`${entry.line}:${entry.name}`}
              entry={entry}
              active={current?.line === entry.line && current?.name === entry.name}
              onJump={onJump}
            />
          ))
        )}
      </div>
    </section>
  );
}

function Row({
  entry,
  active,
  onJump,
}: {
  entry: OutlineEntry;
  active: boolean;
  onJump: (line: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onJump(entry.line)}
      title={entry.detail || entry.name}
      // Indentation carries the nesting, as it does in the tree above.
      style={{ paddingLeft: `${entry.depth * 12 + 6}px` }}
      className={`flex w-full items-center gap-2 rounded py-0.5 pr-2 text-left transition-colors ${
        active ? 'bg-slate-800/70 text-slate-100' : 'text-slate-400 hover:bg-slate-800/40'
      }`}
    >
      <span
        aria-hidden
        className={`w-3 shrink-0 text-center text-[10px] ${TONES[entry.kind] ?? 'text-slate-500'}`}
      >
        {INITIALS[entry.kind] ?? '•'}
      </span>
      <span className="truncate">{entry.name}</span>
      <span className="ml-auto shrink-0 text-[10px] text-slate-600">{entry.line}</span>
    </button>
  );
}
