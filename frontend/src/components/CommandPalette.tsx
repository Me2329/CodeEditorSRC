/**
 * Command palette and quick open.
 *
 * One component serves three modes because they differ only in what they list:
 * commands, files, or symbols. Keeping them together means the keyboard
 * handling, matching and highlighting are written once.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { FileCode, Hash, Search, Terminal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { formatShortcut, rank, type Command } from '../lib/commands';
import type { Symbol as WorkspaceSymbol, VirtualFile } from '../lib/types';

export type PaletteMode = 'commands' | 'files' | 'symbols';

interface Props {
  mode: PaletteMode | null;
  commands: Command[];
  files: VirtualFile[];
  symbols: WorkspaceSymbol[];
  onClose: () => void;
  onOpenFile: (id: string) => void;
  onGoToSymbol: (symbol: WorkspaceSymbol) => void;
}

const PLACEHOLDERS: Record<PaletteMode, string> = {
  commands: 'Type a command…',
  files: 'Go to file…',
  symbols: 'Go to symbol…',
};

/** How many results to render. Beyond this the list stops being scannable. */
const MAX_RESULTS = 60;

export function CommandPalette({
  mode,
  commands,
  files,
  symbols,
  onClose,
  onOpenFile,
  onGoToSymbol,
}: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Each opening starts fresh, otherwise the previous query lingers.
  useEffect(() => {
    setQuery('');
    setSelected(0);
  }, [mode]);

  const results = useMemo(() => {
    if (mode === null) return [];
    if (mode === 'commands') {
      const available = commands.filter((command) => command.when?.() !== false);
      return rank(available, query, (command) => `${command.category} ${command.title}`)
        .slice(0, MAX_RESULTS)
        .map((match) => ({
          key: match.item.id,
          primary: match.item.title,
          secondary: match.item.category,
          trailing: match.item.shortcut ? formatShortcut(match.item.shortcut) : '',
          icon: Terminal,
          activate: match.item.run,
        }));
    }
    if (mode === 'files') {
      return rank(files, query, (file) => file.name)
        .slice(0, MAX_RESULTS)
        .map((match) => ({
          key: match.item.id,
          primary: match.item.name,
          secondary: match.item.language,
          trailing: '',
          icon: FileCode,
          activate: () => onOpenFile(match.item.id),
        }));
    }
    return rank(symbols, query, (symbol) => `${symbol.name} ${symbol.file}`)
      .slice(0, MAX_RESULTS)
      .map((match) => ({
        key: `${match.item.file}:${match.item.line}:${match.item.name}`,
        primary: match.item.name,
        secondary: `${match.item.kind} · ${match.item.file}:${match.item.line}`,
        trailing: '',
        icon: Hash,
        activate: () => onGoToSymbol(match.item),
      }));
  }, [mode, commands, files, symbols, query, onOpenFile, onGoToSymbol]);

  // Clamp the cursor when the result set shrinks under it.
  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, results.length - 1)));
  }, [results.length]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (mode === null) return null;

  const activate = (index: number) => {
    const result = results[index];
    if (!result) return;
    // Close first: a command that opens another overlay must not be undone by
    // this one closing afterwards.
    onClose();
    result.activate();
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 pt-[12vh] backdrop-blur-sm"
        onMouseDown={onClose}
        role="presentation"
      >
        <motion.div
          initial={{ opacity: 0, y: -8, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.99 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(event) => event.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={PLACEHOLDERS[mode]}
          className="w-[min(640px,92vw)] overflow-hidden rounded-xl border border-slate-700/80 bg-charcoal/95 shadow-2xl shadow-black/70"
        >
          <div className="flex items-center gap-2 border-b border-slate-800 px-3">
            <Search className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
            <input
              autoFocus
              value={query}
              placeholder={PLACEHOLDERS[mode]}
              aria-label={PLACEHOLDERS[mode]}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setSelected((current) => (current + 1) % Math.max(1, results.length));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setSelected(
                    (current) => (current - 1 + results.length) % Math.max(1, results.length),
                  );
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  activate(selected);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  onClose();
                }
              }}
              className="flex-1 bg-transparent py-3 text-sm text-slate-100 outline-none placeholder:text-slate-600"
            />
            <kbd className="shrink-0 rounded border border-slate-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
              esc
            </kbd>
          </div>

          <ul ref={listRef} className="max-h-[46vh] overflow-y-auto p-1" role="listbox">
            {results.length === 0 ? (
              <li className="px-3 py-6 text-center text-xs text-slate-600">
                {mode === 'symbols' && symbols.length === 0
                  ? 'No symbols indexed. Is the assistant daemon running?'
                  : 'No matches.'}
              </li>
            ) : (
              results.map((result, index) => {
                const Icon = result.icon;
                return (
                  <li key={result.key} role="option" aria-selected={index === selected}>
                    <button
                      type="button"
                      onMouseEnter={() => setSelected(index)}
                      onClick={() => activate(index)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                        index === selected ? 'bg-indigo-950/70' : 'hover:bg-slate-800/50'
                      }`}
                    >
                      <Icon
                        className={`h-3.5 w-3.5 shrink-0 ${
                          index === selected ? 'text-indigo-300' : 'text-slate-600'
                        }`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate text-xs ${
                            index === selected ? 'text-indigo-100' : 'text-slate-300'
                          }`}
                        >
                          {result.primary}
                        </span>
                        {result.secondary && (
                          <span className="block truncate font-mono text-[10px] text-slate-600">
                            {result.secondary}
                          </span>
                        )}
                      </span>
                      {result.trailing && (
                        <kbd className="shrink-0 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                          {result.trailing}
                        </kbd>
                      )}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
