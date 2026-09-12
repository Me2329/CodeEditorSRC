/**
 * Workspace file tree with inline creation and delete.
 *
 * A real tree, derived from the names: a file called `lib/util.py` appears
 * inside a folder called `lib`. Folders have no existence of their own, so one
 * appears when a file is named as being inside it and goes when the last such
 * file does. That is why there is no "new folder" button: the way to make a
 * folder is to name a file into one.
 */

import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronDown,
  ChevronRight,
  FileCode,
  Folder,
  FolderTree,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { buildTree, flatten, navigate, reveal, toggle } from '../lib/tree';
import { validateFileName } from '../lib/vfs';
import type { VirtualFile } from '../lib/types';

interface Props {
  files: VirtualFile[];
  activeFileId: string;
  entryName: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onDelete: (id: string) => void;
  /** A rename is also a move: the folders are part of the name. */
  onRename: (id: string, name: string) => void;
  /** What goes under the tree, in the same column. The tree answers "which
   *  file" and whatever is passed here answers "where in it". */
  outline?: ReactNode;
}

export function FileExplorer({
  files,
  activeFileId,
  entryName,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  outline,
}: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // The file being renamed, and what it is being renamed to.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  // Which row the arrow keys act on. One row is focusable at a time, which is
  // how a tree widget keeps Tab moving past it rather than through it.
  const [rawCursor, setCursor] = useState(0);

  const rows = useMemo(() => flatten(buildTree(files), collapsed), [files, collapsed]);

  // Deleting a file shortens the list, and a cursor left past the end would
  // focus nothing and make the next arrow key do nothing either.
  const cursor = Math.min(rawCursor, Math.max(0, rows.length - 1));

  const onKeyDown = (event: React.KeyboardEvent) => {
    const move = navigate(rows, cursor, event.key, collapsed);
    const changed =
      move.index !== cursor || move.collapsed !== collapsed || move.activate;
    if (!changed) return;

    event.preventDefault();
    setCursor(move.index);
    setCollapsed(move.collapsed);

    if (move.activate) {
      const row = rows[move.index];
      if (!row) return;
      if (row.node.kind === 'folder') setCollapsed(toggle(move.collapsed, row.node.path));
      else onSelect(row.node.file.id);
    }
  };

  // Showing a file in a folder that is closed should open the folder. Search
  // hits, symbol jumps and the palette all select a file without touching the
  // explorer, and without this the selected row is simply not on screen.
  const activeName = files.find((file) => file.id === activeFileId)?.name;
  useEffect(() => {
    if (activeName) setCollapsed((current) => reveal(current, activeName));
  }, [activeName]);

  const submitRename = () => {
    if (!renaming) return;
    const problem = validateFileName(renaming.value, files, renaming.id);
    if (problem) {
      setRenameError(problem);
      return;
    }
    const trimmed = renaming.value.trim();
    const before = files.find((file) => file.id === renaming.id);
    if (before && before.name !== trimmed) onRename(renaming.id, trimmed);
    setRenaming(null);
    setRenameError(null);
  };

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

      <div
        role="tree"
        aria-label="Workspace files"
        tabIndex={rows.length > 0 ? 0 : -1}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      >
        {rows.map(({ node, depth }, rowIndex) => {
          const focused = rowIndex === cursor;
          // Indentation carries the nesting; a tree drawn with lines costs more
          // width than a 224px panel has to spare.
          const indent = { paddingLeft: `${depth * 12 + 8}px` };

          if (node.kind === 'folder') {
            const isCollapsed = collapsed.has(node.path);
            return (
              <button
                key={`folder:${node.path}`}
                type="button"
                role="treeitem"
                tabIndex={-1}
                onClick={() => {
                  setCursor(rowIndex);
                  setCollapsed((current) => toggle(current, node.path));
                }}
                aria-expanded={!isCollapsed}
                aria-level={depth + 1}
                style={indent}
                className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors hover:bg-slate-800/40 hover:text-slate-200 ${
                  focused ? 'bg-slate-800/60 text-slate-200' : 'text-slate-400'
                }`}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-3 w-3 shrink-0 text-slate-600" aria-hidden />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0 text-slate-600" aria-hidden />
                )}
                <Folder className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
                <span className="truncate">{node.name}</span>
              </button>
            );
          }

          const file = node.file;
          const isActive = file.id === activeFileId;
          const isEntry = file.name === entryName;

          if (renaming?.id === file.id) {
            return (
              <div key={file.id} style={indent} className="pr-2">
                <input
                  autoFocus
                  value={renaming.value}
                  onChange={(event) => {
                    setRenaming({ id: file.id, value: event.target.value });
                    setRenameError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submitRename();
                    if (event.key === 'Escape') {
                      setRenaming(null);
                      setRenameError(null);
                    }
                  }}
                  onBlur={submitRename}
                  aria-label={`Rename ${file.name}`}
                  aria-invalid={renameError !== null}
                  className="w-full rounded border border-indigo-800/60 bg-slate-900 px-2 py-1 text-xs text-slate-100 outline-none focus:border-accent"
                />
                {renameError && (
                  <p role="alert" className="mt-1 px-1 text-[10px] leading-snug text-halt">
                    {renameError}
                  </p>
                )}
              </div>
            );
          }

          return (
            <div key={file.id} className="group relative">
              <button
                type="button"
                role="treeitem"
                tabIndex={-1}
                aria-level={depth + 1}
                onClick={() => {
                  setCursor(rowIndex);
                  onSelect(file.id);
                }}
                // The gesture people try first, before looking for a button.
                onDoubleClick={() => {
                  setRenaming({ id: file.id, value: file.name });
                  setRenameError(null);
                }}
                aria-current={isActive}
                style={indent}
                className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors ${
                  isActive
                    ? 'border border-indigo-800/50 bg-indigo-950/60 text-indigo-200'
                    : focused
                      ? 'border border-transparent bg-slate-800/60 text-slate-200'
                      : 'border border-transparent text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
                }`}
                title={file.name}
              >
                <FileCode
                  className={`h-3.5 w-3.5 shrink-0 ${isEntry ? 'text-run' : 'text-slate-500'}`}
                  aria-hidden
                />
                <span className="truncate">{node.name}</span>
                {isEntry && (
                  <span
                    className="ml-auto shrink-0 rounded bg-emerald-950/60 px-1 text-[9px] uppercase tracking-wide text-run"
                    title="Entry point for this runtime"
                  >
                    entry
                  </span>
                )}
              </button>

              {/* The entry file is left alone by both, for the same reason:
                  the runtime looks it up by name, so renaming or deleting it
                  leaves nothing to run. */}
              {!isEntry && (
                <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center group-hover:flex">
                  <button
                    type="button"
                    onClick={() => {
                      setRenaming({ id: file.id, value: file.name });
                      setRenameError(null);
                    }}
                    className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
                    title={`Rename ${file.name}`}
                    aria-label={`Rename ${file.name}`}
                  >
                    <Pencil className="h-3 w-3" aria-hidden />
                  </button>
                  {files.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onDelete(file.id)}
                      className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-halt"
                      title={`Delete ${file.name}`}
                      aria-label={`Delete ${file.name}`}
                    >
                      <Trash2 className="h-3 w-3" aria-hidden />
                    </button>
                  )}
                </div>
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

      {outline}
    </aside>
  );
}
