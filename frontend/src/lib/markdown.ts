/**
 * Markdown to HTML, by hand.
 *
 * A `.md` file in this workspace had nothing to look at: the preview pane
 * renders HTML, and markdown went to the editor and stopped there. Notes,
 * READMEs and design documents are most of what people write beside code.
 *
 * Written rather than installed, for the same reason the zip writer is. A
 * markdown library is a few hundred kilobytes of bundle to render headings and
 * lists, and the subset that matters here is small enough to read in one
 * sitting.
 *
 * What it does: headings, paragraphs, fenced and indented code, inline code,
 * bold, italic, strikethrough, links, images, blockquotes, ordered and
 * unordered lists, horizontal rules and pipe tables.
 *
 * What it does not: nested lists, reference links, footnotes, HTML passthrough,
 * setext headings. Those are absent on purpose and the list is here so the gap
 * is known rather than discovered.
 *
 * Every piece of source text is escaped before anything else happens, so HTML
 * written in a markdown file appears as text. That is a deliberate difference
 * from the reference implementations, which pass HTML through: this renders
 * into a sandboxed frame, but a renderer that can emit arbitrary markup is one
 * bad sandbox away from being a problem, and passthrough is not worth it.
 */

/** The four characters that could otherwise close or open a tag. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A URL safe to put in an href, or null.
 *
 * Anything that is not plainly http, https, mailto or a relative path is
 * refused. `javascript:` is the reason, and a scheme list is the only check
 * that stays right as new schemes are invented.
 */
export function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // A scheme is letters, digits, +, - or . before the first colon. No colon
  // before the first slash means it is relative, which is fine.
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!scheme) return trimmed.includes('\n') ? null : trimmed;
  return ['http', 'https', 'mailto'].includes(scheme[1]!.toLowerCase()) ? trimmed : null;
}

/** Inline markup, on text that has already been escaped. */
function inlineOn(escaped: string): string {
  return escaped
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt: string, url: string) => {
      const href = safeHref(url);
      return href ? `<img src="${href}" alt="${alt}">` : whole;
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text: string, url: string) => {
      const href = safeHref(url);
      // rel and target because a preview is a frame, and a link that replaces
      // it with another site is a preview that has stopped being one.
      return href
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : whole;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

/**
 * Inline markup, with code spans held out of it.
 *
 * `**not bold**` inside backticks has to survive, so the string is split on
 * code spans and only the parts between them are transformed.
 */
export function renderInline(source: string): string {
  const pieces = source.split(/(`+)/);
  let out = '';
  let index = 0;

  while (index < pieces.length) {
    const piece = pieces[index]!;
    if (!/^`+$/.test(piece)) {
      out += inlineOn(escapeHtml(piece));
      index += 1;
      continue;
    }

    // A run of backticks opens a code span that the same run closes.
    const closing = pieces.indexOf(piece, index + 1);
    if (closing === -1) {
      out += escapeHtml(piece);
      index += 1;
      continue;
    }
    const inner = pieces.slice(index + 1, closing).join('');
    out += `<code>${escapeHtml(inner)}</code>`;
    index = closing + 1;
  }

  return out;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Render a markdown document as HTML. */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const language = fence[2] ?? '';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trimStart().startsWith(marker)) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1; // The closing fence, or the end of the document.
      const attribute = language ? ` class="language-${escapeHtml(language)}"` : '';
      out.push(`<pre><code${attribute}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (RULE.test(line)) {
      out.push('<hr>');
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(heading[2]!)}</h${level}>`);
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        body.push(QUOTE.exec(lines[index]!)![1]!);
        index += 1;
      }
      // Recursive, so a quote can hold a list or a heading like any other text.
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }

    // A table is a row of cells whose next line is the divider. Without the
    // divider it is a paragraph that happens to contain pipes.
    if (line.includes('|') && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]!)) {
      const header = cells(line);
      index += 2;
      const body: string[][] = [];
      while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim()) {
        body.push(cells(lines[index]!));
        index += 1;
      }
      const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
      const rows = body
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`);
      continue;
    }

    const ordered = NUMBERED.test(line);
    if (ordered || BULLET.test(line)) {
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (index < lines.length && pattern.test(lines[index]!)) {
        items.push(`<li>${renderInline(pattern.exec(lines[index]!)![1]!)}</li>`);
        index += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim()) {
      const next = lines[index]!;
      if (
        paragraph.length > 0 &&
        (HEADING.test(next) || RULE.test(next) || FENCE.test(next) || QUOTE.test(next) ||
          BULLET.test(next) || NUMBERED.test(next))
      ) {
        break;
      }
      paragraph.push(next);
      index += 1;
    }
    out.push(`<p>${renderInline(paragraph.join('\n'))}</p>`);
  }

  return out.join('\n');
}
