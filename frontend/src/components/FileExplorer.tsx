/** Workspace file tree with inline creation, rename and delete. */

import { AnimatePresence, motion } from 'framer-motion';
import { FileCode, FolderTree, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';

import { validateFileName } from '../lib/vfs';
import type { VirtualFile } from '../lib/types';

interface Props {
  files: VirtualFile[];
  activeFileId: string;
  entryName: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onDelete: (id: string) => void;
}

export function FileExplorer({
  files,
  activeFileId,
  entryName,
  onSelect,
  onCreate,
  onDelete,
}: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (draft === null) return;
    const problem = validateFileName(draft, files);
    if (problem) {
      setError(problem);
      return;
    }
    onCreate(draft.trim());
    setDraft(null);
    setError(null);
  };

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800/80 bg-panel">
      <header className="flex h-9 items-center justify-between border-b border-slate-800/80 px-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          <FolderTree className="h-3.5 w-3.5 text-accent" aria-hidden />
          <span>Workspace</span>
        </div>
        <button
          type="button"
          onClick={() => {
            setDraft('');
            setError(null);
          }}
          className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
          title="New file"
          aria-label="New file"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2 font-mono text-xs">
        {files.map((file) => {
          const isActive = file.id === activeFileId;
          const isEntry = file.name === entryName;
          return (
            <div key={file.id} className="group relative">
              <button
                type="button"
                onClick={() => onSelect(file.id)}
                aria-current={isActive}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                  isActive
                    ? 'border border-indigo-800/50 bg-indigo-950/60 text-indigo-200'
                    : 'border border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
                }`}
              >
                <FileCode
                  className={`h-3.5 w-3.5 shrink-0 ${isEntry ? 'text-run' : 'text-slate-500'}`}
                  aria-hidden
                />
                <span className="truncate">{file.name}</span>
                {isEntry && (
                  <span
                    className="ml-auto shrink-0 rounded bg-emerald-950/60 px-1 text-[9px] uppercase tracking-wide text-run"
                    title="Entry point for this runtime"
                  >
                    entry
                  </span>
                )}
              </button>

              {files.length > 1 && !isEntry && (
                <button
                  type="button"
                  onClick={() => onDelete(file.id)}
                  className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-halt group-hover:block"
                  title={`Delete ${file.name}`}
                  aria-label={`Delete ${file.name}`}
                >
                  <Trash2 className="h-3 w-3" aria-hidden />
                </button>
              )}
            </div>
          );
        })}

        <AnimatePresence>
          {draft !== null && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="pt-1"
            >
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={draft}
                  placeholder="util.py"
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submit();
                    if (event.key === 'Escape') {
                      setDraft(null);
                      setError(null);
                    }
                  }}
                  onBlur={submit}
                  aria-label="New file name"
                  aria-invalid={error !== null}
                  className="w-full rounded border border-indigo-800/60 bg-slate-900 px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setDraft(null);
                    setError(null);
                  }}
                  className="rounded p-1 text-slate-500 hover:text-slate-200"
                  aria-label="Cancel"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </div>
              {error && (
                <p role="alert" className="mt-1 px-1 text-[10px] leading-snug text-halt">
                  {error}
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </aside>
  );
}
