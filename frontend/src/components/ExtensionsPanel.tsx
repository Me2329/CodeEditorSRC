/**
 * Browse and toggle extensions.
 *
 * Deliberately shows what each one actually contributes rather than a
 * description alone: "adds 30 text actions and 4 linters" is the information
 * that decides whether you want it, and it is derived from the manifest rather
 * than written by hand, so it cannot drift.
 */

import { AlertTriangle, Package, Power } from 'lucide-react';

import type { ExtensionState } from '../lib/extensions/types';

interface Props {
  extensions: readonly ExtensionState[];
  onToggle: (id: string, enabled: boolean) => void;
}

/** Summarise a manifest's contributions the way a package listing would. */
function summarise(state: ExtensionState): string {
  const contributes = state.extension.contributes ?? {};
  const parts: string[] = [];

  const count = (value: readonly unknown[] | undefined) => value?.length ?? 0;
  const add = (n: number, singular: string, plural = `${singular}s`) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? singular : plural}`);
  };

  add(count(contributes.commands), 'command');
  add(count(contributes.textActions), 'text action');
  add(count(contributes.snippets), 'snippet');
  add(count(contributes.linters), 'linter');
  add(count(contributes.formatters), 'formatter');
  add(count(contributes.languages), 'language config', 'language configs');
  add(count(contributes.statusBar), 'status item');
  add(count(contributes.themes), 'theme');

  return parts.length ? parts.join(', ') : 'no contributions';
}

export function ExtensionsPanel({ extensions, onToggle }: Props) {
  const enabled = extensions.filter((state) => state.enabled).length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-slate-800/80 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        <Package className="h-3.5 w-3.5 text-caret" aria-hidden />
        <span>Extensions</span>
        <span className="ml-auto font-mono text-[10px] normal-case tracking-normal text-slate-500">
          {enabled} of {extensions.length} enabled
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {extensions.length === 0 ? (
          <p className="p-3 text-xs text-slate-500">No extensions are installed.</p>
        ) : (
          <ul className="divide-y divide-slate-800/60">
            {extensions.map((state) => (
              <ExtensionRow key={state.extension.manifest.id} state={state} onToggle={onToggle} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ExtensionRow({
  state,
  onToggle,
}: {
  state: ExtensionState;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  const { manifest } = state.extension;

  return (
    <li className={`px-3 py-2.5 ${state.enabled ? '' : 'opacity-55'}`}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-base leading-none" aria-hidden>
          {manifest.icon ?? '📦'}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate text-xs font-semibold text-slate-200">{manifest.name}</h3>
            <span className="shrink-0 font-mono text-[10px] text-slate-600">
              v{manifest.version}
            </span>
          </div>

          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
            {manifest.description}
          </p>

          <p className="mt-1 font-mono text-[10px] text-slate-600">{summarise(state)}</p>

          {state.error && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-300/90">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span>Failed to activate: {state.error}</span>
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => onToggle(manifest.id, !state.enabled)}
          aria-pressed={state.enabled}
          title={state.enabled ? `Disable ${manifest.name}` : `Enable ${manifest.name}`}
          className={`mt-0.5 flex shrink-0 items-center gap-1 rounded border px-1.5 py-1 text-[10px] font-medium transition-colors ${
            state.enabled
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
              : 'border-slate-700 text-slate-500 hover:border-slate-600 hover:text-slate-300'
          }`}
        >
          <Power className="h-3 w-3" aria-hidden />
          {state.enabled ? 'On' : 'Off'}
        </button>
      </div>
    </li>
  );
}
