/**
 * Live web preview, and rendered markdown.
 *
 * HTML workspaces never reach the execution backend; they render here in a
 * sandboxed iframe. The sandbox grants scripts but deliberately withholds
 * allow-same-origin, so the frame gets an opaque origin and cannot read cookies,
 * storage or the DOM of the page hosting it.
 *
 * A markdown file renders through the same frame, which is why the renderer
 * escapes everything rather than passing HTML through: the sandbox is a second
 * line, not the first.
 */

import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { renderMarkdown } from '../lib/markdown';
import type { VirtualFile } from '../lib/types';

interface Props {
  files: VirtualFile[];
  entryName: string;
  /** Render this file as markdown instead of treating it as a document. */
  markdown?: boolean;
}

/** Debounce so a preview is not rebuilt on every keystroke. */
const REFRESH_DELAY_MS = 400;

export function PreviewPane({ files, entryName, markdown = false }: Props) {
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
  const document = useMemo(
    () => (markdown ? markdownPage(debounced) : inlineAssets(debounced, files)),
    [debounced, files, markdown],
  );

  return (
    <section className="flex min-h-0 flex-col bg-obsidian">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-slate-800/80 bg-charcoal px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
          {markdown ? 'Markdown preview' : 'Live preview'}
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

/**
 * Rendered markdown, wrapped in a page that reads like the editor around it.
 *
 * The stylesheet is inline and small on purpose: a preview that has to fetch a
 * font or a stylesheet would not render at all on the airgapped networks this
 * editor is meant to run on.
 */
function markdownPage(source: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 24px 28px;
    background: #0b0f19; color: #cbd5e1;
    font: 14px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  h1, h2, h3, h4, h5, h6 { color: #e2e8f0; line-height: 1.25; margin: 1.6em 0 0.6em; }
  h1 { font-size: 1.7em; border-bottom: 1px solid #1e293b; padding-bottom: 0.3em; }
  h2 { font-size: 1.35em; border-bottom: 1px solid #1e293b; padding-bottom: 0.25em; }
  h3 { font-size: 1.15em; }
  :where(h1, h2, h3, h4, h5, h6):first-child { margin-top: 0; }
  p, ul, ol, blockquote, table, pre { margin: 0 0 1em; }
  a { color: #818cf8; }
  code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9em;
    background: #111827; border: 1px solid #1f2937; border-radius: 4px; padding: 0.1em 0.35em;
  }
  pre {
    background: #111827; border: 1px solid #1f2937; border-radius: 8px;
    padding: 12px 14px; overflow-x: auto;
  }
  pre code { background: none; border: 0; padding: 0; font-size: 0.86em; }
  blockquote {
    border-left: 3px solid #4f46e5; margin-left: 0; padding: 0.1em 0 0.1em 14px; color: #94a3b8;
  }
  hr { border: 0; border-top: 1px solid #1e293b; margin: 2em 0; }
  table { border-collapse: collapse; width: 100%; font-size: 0.92em; }
  th, td { border: 1px solid #1e293b; padding: 6px 10px; text-align: left; }
  th { background: #111827; color: #e2e8f0; }
  img { max-width: 100%; }
  li { margin: 0.25em 0; }
</style></head><body>
${renderMarkdown(source)}
</body></html>`;
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
