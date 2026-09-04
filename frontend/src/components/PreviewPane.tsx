/**
 * Live web preview.
 *
 * HTML workspaces never reach the execution backend; they render here in a
 * sandboxed iframe. The sandbox grants scripts but deliberately withholds
 * allow-same-origin, so the frame gets an opaque origin and cannot read cookies,
 * storage or the DOM of the page hosting it.
 */

import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { VirtualFile } from '../lib/types';

interface Props {
  files: VirtualFile[];
  entryName: string;
}

/** Debounce so a preview is not rebuilt on every keystroke. */
const REFRESH_DELAY_MS = 400;

export function PreviewPane({ files, entryName }: Props) {
  const entry = files.find((file) => file.name === entryName) ?? files[0];
  const source = entry?.content ?? '';

  const [debounced, setDebounced] = useState(source);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(source), REFRESH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [source]);

  // Inline sibling stylesheets and scripts so a multi-file workspace previews as
  // one document; the iframe has no server to fetch relative paths from.
  const document = useMemo(() => inlineAssets(debounced, files), [debounced, files]);

  return (
    <section className="flex min-h-0 flex-col bg-obsidian">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-slate-800/80 bg-charcoal px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
          Live preview
        </span>
        <button
          type="button"
          onClick={() => setReloadKey((key) => key + 1)}
          className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
          title="Reload preview"
          aria-label="Reload preview"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        </button>
      </header>
      <iframe
        key={reloadKey}
        title="Live preview"
        srcDoc={document}
        sandbox="allow-scripts allow-modals allow-forms"
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </section>
  );
}

function inlineAssets(html: string, files: readonly VirtualFile[]): string {
  let output = html;

  for (const file of files) {
    if (file.name.endsWith('.css')) {
      const pattern = new RegExp(
        `<link[^>]*href=["']\\.?/?${escapeForRegExp(file.name)}["'][^>]*>`,
        'gi',
      );
      output = output.replace(pattern, `<style>\n${file.content}\n</style>`);
    } else if (file.name.endsWith('.js')) {
      const pattern = new RegExp(
        `<script[^>]*src=["']\\.?/?${escapeForRegExp(file.name)}["'][^>]*>\\s*</script>`,
        'gi',
      );
      output = output.replace(pattern, `<script>\n${file.content}\n</script>`);
    }
  }

  return output;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
