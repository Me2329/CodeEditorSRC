/**
 * Where the caret is, in one line above the editor.
 *
 * `lib / parser.py / Parser / consume`. The folders come from the file name,
 * which is where folders live in this workspace, and the declarations come
 * from the outline. Clicking a declaration goes to it, which is what makes this
 * more than decoration: it is the fastest way out of a long method and back to
 * the top of its class.
 *
 * Nothing is shown for a file with no folders and no declaration around the
 * caret, because a bar saying only the file name is a row of pixels spent
 * repeating the tab above it.
 */

import { ChevronRight } from 'lucide-react';
import { useMemo } from 'react';

import { type OutlineEntry, ancestry } from '../lib/outline';

interface Props {
  fileName: string;
  /** The file's declarations in line order, as the outline panel receives them. */
  entries: OutlineEntry[];
  line: number;
  onJump: (line: number) => void;
}

export function Breadcrumbs({ fileName, entries, line, onJump }: Props) {
  const chain = useMemo(() => ancestry(entries, line), [entries, line]);

  const folders = fileName.split('/').slice(0, -1);
  const base = fileName.split('/').pop() ?? '';
  if (!base || (folders.length === 0 && chain.length === 0)) return null;

  return (
    <nav
      aria-label="Breadcrumbs"
      className="flex h-6 shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-800/60 bg-charcoal/60 px-3 font-mono text-[10.5px] text-slate-500"
    >
      {folders.map((folder, index) => (
        <Segment key={`folder:${index}:${folder}`} first={index === 0}>
          {folder}
        </Segment>
      ))}
      <Segment first={folders.length === 0}>
        <span className="text-slate-300">{base}</span>
      </Segment>
      {chain.map((entry) => (
        <Segment key={`symbol:${entry.line}:${entry.name}`} first={false}>
          <button
            type="button"
            onClick={() => onJump(entry.line)}
            title={entry.detail || `Line ${entry.line}`}
            className="rounded px-0.5 text-slate-400 hover:bg-slate-800/60 hover:text-slate-100"
          >
            {entry.name}
          </button>
        </Segment>
      ))}
    </nav>
  );
}

function Segment({ children, first }: { children: React.ReactNode; first: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {!first && <ChevronRight className="h-3 w-3 text-slate-700" aria-hidden />}
      {children}
    </span>
  );
}
