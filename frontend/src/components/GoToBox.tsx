/**
 * One box that takes whatever you paste into it.
 *
 * A go-to-line prompt that only accepts a bare number is one you end up editing
 * before you can use it. What people have in hand is a compiler's
 * `main.py:42:8`, a stack frame's `at line 42`, a diff's `@@ -42`, or a rough
 * idea like "about halfway". Each is one small rule in `goto.ts`.
 *
 * The box says what it understood, on the line below, before you commit to it —
 * so a misreading is visible while it is still a keystroke away from being
 * corrected, rather than after the caret has gone somewhere surprising.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { describeTarget, parseTarget, resolveFile, resolveLine } from '../lib/goto';
import type { VirtualFile } from '../lib/types';

interface Props {
  files: readonly VirtualFile[];
  /** The file the caret is in, whose length bounds a bare line number. */
  activeFile: VirtualFile | null;
  caretLine: number;
  onGo: (fileId: string | null, line: number, column: number | undefined) => void;
  onClose: () => void;
}

export function GoToBox({ files, activeFile, caretLine, onGo, onClose }: Props) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const target = useMemo(() => parseTarget(text), [text]);
  const file = useMemo(() => resolveFile(files, target?.file), [files, target?.file]);
  const content = file?.content ?? activeFile?.content ?? '';
  const totalLines = content === '' ? 1 : content.split('\n').length;
  const line = target ? resolveLine(target, totalLines, caretLine) : null;

  // A file that was named but is not open is the one case worth refusing: going
  // to line 42 of the wrong file is worse than not going anywhere.
  const missing = Boolean(target?.file) && file === null;
  const ready = target !== null && !missing;

  const go = () => {
    if (!ready || line === null) return;
    onGo(file?.id ?? null, line, target?.column);
  };

  return (
    <div
      className="absolute inset-0 z-30 flex items-start justify-center bg-slate-950/50 pt-[18vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Go to"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center gap-2 p-3">
          <span className="shrink-0 font-mono text-[11px] text-slate-500">Go to</span>
          <input
            ref={input}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              // The box closes and hands focus back to the editor inside `go`,
              // and without these the same Enter carries on into the editor and
              // inserts a newline — which moves the caret one line past where
              // it was just sent, and edits the file to do it.
              event.preventDefault();
              event.stopPropagation();
              go();
            }}
            placeholder="42, 42:8, main.py:42, +10, 50%"
            aria-label="Where to go"
            className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-indigo-500"
          />
        </div>
        <p
          className={`border-t border-slate-800 px-3 py-2 font-mono text-[10px] ${
            missing ? 'text-amber-500/90' : 'text-slate-500'
          }`}
        >
          {missing
            ? `${target?.file} is not open in this workspace.`
            : describeTarget(target, line)}
        </p>
      </div>
    </div>
  );
}
