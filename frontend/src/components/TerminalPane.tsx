/**
 * Xterm.js execution console.
 *
 * Output is written straight to the terminal as it arrives rather than being
 * accumulated in React state: a program printing in a tight loop would
 * otherwise re-render the tree on every chunk.
 */

import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { Eraser, Terminal as TerminalIcon } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import '@xterm/xterm/css/xterm.css';

export interface TerminalHandle {
  write: (text: string) => void;
  writeLine: (text: string) => void;
  clear: () => void;
}

interface Props {
  /** Rendered at the right of the header, e.g. the last run's duration. */
  status?: React.ReactNode;
}

export const TerminalPane = forwardRef<TerminalHandle, Props>(function TerminalPane(
  { status },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      theme: {
        background: '#0b0e14',
        foreground: '#e2e8f0',
        cursor: '#a855f7',
        selectionBackground: '#6366f166',
        black: '#0b0e14',
        red: '#ef4444',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#6366f1',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e2e8f0',
      },
      fontFamily: '"Fira Code", "JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      // The gateway forwards raw "\n" from program output; without this a
      // Unix-style newline would move down without returning to column zero.
      convertEol: true,
      scrollback: 5000,
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(host);

    terminalRef.current = terminal;
    fitRef.current = fit;

    terminal.writeln('\x1b[1;35m CodeCraft Studio execution console\x1b[0m');
    terminal.writeln('\x1b[38;5;244m Pick a runtime and press Run, or Ctrl+Enter.\x1b[0m');
    terminal.writeln('');

    // The terminal must re-measure whenever its container changes size, which a
    // window resize listener alone would miss when a side panel is toggled.
    const observer = new ResizeObserver(() => {
      // Fitting a zero-sized element throws; skip while the pane is hidden.
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          fit.fit();
        } catch {
          // Layout is mid-transition; the next observation will settle it.
        }
      }
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      write: (text: string) => terminalRef.current?.write(text),
      writeLine: (text: string) => terminalRef.current?.writeln(text),
      clear: () => {
        terminalRef.current?.clear();
        terminalRef.current?.reset();
      },
    }),
    [],
  );

  return (
    <section className="flex min-h-0 flex-col bg-obsidian">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-slate-800/80 bg-charcoal px-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-300">
          <TerminalIcon className="h-3.5 w-3.5 text-accent" aria-hidden />
          <span>Execution console</span>
        </div>
        <div className="flex items-center gap-2">
          {status}
          <button
            type="button"
            onClick={() => {
              terminalRef.current?.clear();
              terminalRef.current?.reset();
            }}
            className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
            title="Clear console"
            aria-label="Clear console"
          >
            <Eraser className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </header>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-2" />
    </section>
  );
});
