/**
 * Runtime selector.
 *
 * Runtimes are grouped by execution paradigm and each one shows whether its
 * toolchain is present on this node, so an unavailable choice is visible before
 * it is selected rather than failing at run time.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, CircleSlash } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { RuntimeInfo } from '../lib/types';

const CATEGORY_LABELS: Record<string, string> = {
  native: 'Native compiled',
  interpreted: 'Interpreted',
  managed: 'Managed VM',
  web: 'Web and scripting',
};

interface Props {
  runtimes: RuntimeInfo[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

export function RuntimePicker({ runtimes, value, onChange, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = runtimes.find((runtime) => runtime.id === value);

  const grouped = useMemo(() => {
    const groups = new Map<string, RuntimeInfo[]>();
    for (const runtime of runtimes) {
      const bucket = groups.get(runtime.category) ?? [];
      bucket.push(runtime);
      groups.set(runtime.category, bucket);
    }
    // Installed runtimes first so the usable options are never buried.
    for (const bucket of groups.values()) {
      bucket.sort((a, b) => {
        if (a.installed !== b.installed) return a.installed ? -1 : 1;
        return a.label.localeCompare(b.label);
      });
    }
    return [...groups.entries()].sort(
      (a, b) =>
        Object.keys(CATEGORY_LABELS).indexOf(a[0]) - Object.keys(CATEGORY_LABELS).indexOf(b[0]),
    );
  }, [runtimes]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex min-w-[190px] items-center justify-between gap-2 rounded-lg border border-slate-700/80 bg-slate-900/90 px-3 py-1.5 font-mono text-xs text-indigo-200 transition-colors hover:border-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="flex items-center gap-2 truncate">
          {selected && !selected.installed && (
            <CircleSlash className="h-3 w-3 shrink-0 text-amber-400" aria-hidden />
          )}
          <span className="truncate">{selected?.label ?? 'Select a runtime'}</span>
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.12 }}
            role="listbox"
            className="absolute left-0 z-50 mt-1.5 max-h-[26rem] w-72 overflow-y-auto rounded-lg border border-slate-700/80 bg-charcoal/95 p-1 shadow-2xl shadow-black/60 backdrop-blur-xl"
          >
            {grouped.map(([category, items]) => (
              <div key={category} className="py-1">
                <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  {CATEGORY_LABELS[category] ?? category}
                </p>
                {items.map((runtime) => {
                  const isSelected = runtime.id === value;
                  const unavailable = !runtime.installed && runtime.executable;
                  return (
                    <button
                      key={runtime.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => {
                        onChange(runtime.id);
                        setOpen(false);
                      }}
                      title={
                        unavailable
                          ? 'This toolchain is not installed on this node'
                          : (runtime.notes ?? undefined)
                      }
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-xs transition-colors ${
                        isSelected
                          ? 'bg-indigo-950/70 text-indigo-200'
                          : 'text-slate-300 hover:bg-slate-800/60'
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          runtime.installed
                            ? 'bg-run'
                            : runtime.executable
                              ? 'bg-slate-600'
                              : 'bg-caret'
                        }`}
                        aria-hidden
                      />
                      <span className={`truncate ${unavailable ? 'text-slate-500' : ''}`}>
                        {runtime.label}
                      </span>
                      {isSelected && <Check className="ml-auto h-3 w-3 shrink-0" aria-hidden />}
                    </button>
                  );
                })}
              </div>
            ))}
            <p className="border-t border-slate-800 px-2 py-1.5 text-[10px] leading-snug text-slate-500">
              <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-run align-middle" />
              installed
              <span className="ml-3 mr-1 inline-block h-1.5 w-1.5 rounded-full bg-slate-600 align-middle" />
              not on this node
              <span className="ml-3 mr-1 inline-block h-1.5 w-1.5 rounded-full bg-caret align-middle" />
              browser preview
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
