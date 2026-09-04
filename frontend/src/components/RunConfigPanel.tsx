/**
 * Run configuration: standard input and command-line arguments.
 *
 * Without this, a program that reads input cannot be run at all, which rules
 * out most exercises and teaching examples. Arguments are parsed here with
 * shell-style quoting so a value containing spaces stays one argument, but
 * nothing is ever handed to a shell: the parsed list travels as an argv array
 * the whole way down.
 */

import { ChevronDown, TerminalSquare } from 'lucide-react';
import { useMemo, useState } from 'react';

interface Props {
  stdin: string;
  argsText: string;
  onStdinChange: (value: string) => void;
  onArgsChange: (value: string) => void;
}

/**
 * Split a command line into arguments, honouring single and double quotes and
 * backslash escapes. Unlike a shell it performs no expansion whatsoever: no
 * globbing, no variables, no substitution.
 */
export function parseArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;

    if (quote === null && (character === ' ' || character === '\t' || character === '\n')) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    if (character === '\\' && quote !== "'" && index + 1 < input.length) {
      current += input[index + 1];
      started = true;
      index += 1;
      continue;
    }

    if (quote === null && (character === '"' || character === "'")) {
      quote = character;
      // An empty quoted string is still an argument.
      started = true;
      continue;
    }

    if (quote !== null && character === quote) {
      quote = null;
      continue;
    }

    current += character;
    started = true;
  }

  if (started) args.push(current);
  return args;
}

export function RunConfigPanel({ stdin, argsText, onStdinChange, onArgsChange }: Props) {
  const [open, setOpen] = useState(false);
  const parsed = useMemo(() => parseArgs(argsText), [argsText]);
  const summary = [
    stdin ? `${stdin.split('\n').filter(Boolean).length} input line(s)` : '',
    parsed.length ? `${parsed.length} arg(s)` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="border-b border-slate-800/80 bg-panel">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-8 w-full items-center gap-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500 transition-colors hover:text-slate-300"
      >
        <TerminalSquare className="h-3.5 w-3.5" aria-hidden />
        <span>Run configuration</span>
        {summary && !open && (
          <span className="font-mono text-[9px] normal-case tracking-normal text-slate-600">
            {summary}
          </span>
        )}
        <ChevronDown
          className={`ml-auto h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open && (
        <div className="space-y-2 px-3 pb-3">
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-slate-500">
              Standard input
            </span>
            <textarea
              rows={3}
              value={stdin}
              placeholder={'Lines your program reads from stdin\nOne per line'}
              onChange={(event) => onStdinChange(event.target.value)}
              className="w-full resize-y rounded border border-slate-800 bg-slate-900/60 px-2 py-1.5 font-mono text-[11px] text-slate-200 outline-none placeholder:text-slate-700 focus:border-accent"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-slate-500">
              Arguments
            </span>
            <input
              value={argsText}
              placeholder={'--verbose "two words" 42'}
              onChange={(event) => onArgsChange(event.target.value)}
              className="w-full rounded border border-slate-800 bg-slate-900/60 px-2 py-1.5 font-mono text-[11px] text-slate-200 outline-none placeholder:text-slate-700 focus:border-accent"
            />
          </label>

          {parsed.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {parsed.map((argument, index) => (
                <span
                  key={`${index}-${argument}`}
                  className="rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-slate-400"
                  title={`argv[${index + 1}]`}
                >
                  {argument || '""'}
                </span>
              ))}
            </div>
          )}

          <p className="text-[9px] leading-relaxed text-slate-600">
            Quoting is handled here, not by a shell. Nothing is expanded, so
            <span className="mx-1 font-mono text-slate-500">$(cmd)</span>
            reaches your program as literal text.
          </p>
        </div>
      )}
    </div>
  );
}
