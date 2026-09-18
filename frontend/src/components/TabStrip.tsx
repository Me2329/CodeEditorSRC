/**
 * The row of open files above the editor.
 *
 * Middle-click closes, which is the gesture people reach for without thinking
 * and notice immediately when it is missing. Drag reorders.
 */

import { X } from 'lucide-react';
import { useState } from 'react';

import type { VirtualFile } from '../lib/types';

interface Props {
  files: readonly VirtualFile[];
  open: readonly string[];
  active: string | null;
  /** The file the runtime treats as the entry point, marked so it stands out. */
  entryName: string;
  onSelect: (fileId: string) => void;
  onClose: (fileId: string) => void;
  onReorder: (fileId: string, to: number) => void;
}

export function TabStrip({
  files,
  open,
  active,
  entryName,
  onSelect,
  onClose,
  onReorder,
}: Props) {
  const [dragging, setDragging] = useState<string | null>(null);

  if (open.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-slate-800/80 bg-charcoal"
    >
      {open.map((fileId, index) => {
        const file = files.find((entry) => entry.id === fileId);
        if (!file) return null;
        const isActive = fileId === active;

        return (
          <div
            key={fileId}
            role="tab"
            aria-selected={isActive}
            draggable
            onDragStart={() => setDragging(fileId)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging && dragging !== fileId) onReorder(dragging, index);
              setDragging(null);
            }}
            // Middle-click is button 1 and only fires on mouseDown for it.
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(fileId);
              }
            }}
            className={`group flex min-w-0 shrink-0 items-center gap-1.5 border-r border-slate-800/80 px-3 text-[11px] transition-colors ${
              isActive
                ? 'bg-obsidian text-slate-200'
                : 'text-slate-500 hover:bg-slate-800/40 hover:text-slate-300'
            } ${dragging === fileId ? 'opacity-50' : ''}`}
          >
            <button
              type="button"
              onClick={() => onSelect(fileId)}
              className="min-w-0 truncate font-mono"
              title={file.name}
            >
              {file.name}
            </button>

            {file.name === entryName && (
              <span
                className="shrink-0 rounded bg-accent/15 px-1 text-[9px] uppercase tracking-wide text-accent"
                title="The runtime starts here"
              >
                entry
              </span>
            )}

            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onClose(fileId);
              }}
              aria-label={`Close ${file.name}`}
              // Visible on the active tab and on hover: a row of close buttons
              // is noise, and a hidden one on the tab you are using is a miss.
              className={`shrink-0 rounded p-0.5 text-slate-600 transition-opacity hover:bg-slate-700/60 hover:text-slate-200 ${
                isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
