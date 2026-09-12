/**
 * Text operations that are faster to run than to do by hand.
 *
 * Sorting a list, removing duplicates, joining wrapped lines, escaping a string
 * for JSON: each of these is a minute of careful editing or a keystroke, and
 * the minute is the kind that introduces a typo three lines from where you were
 * looking.
 *
 * They all have the same shape, `string -> string`, so the editor can apply any
 * of them to the selection or to the whole file with one piece of code. That
 * shape is also why they are here rather than in the component: a pure function
 * over text is a thing that can be tested exhaustively, and several of these
 * have edge cases that matter.
 *
 * Line endings: everything here works on `\n` and leaves a trailing newline
 * where it found one, because a transform that quietly strips the last newline
 * makes every file it touches look changed.
 */

export interface Transform {
  id: string;
  title: string;
  /** Shown in the palette so a destructive one is recognisable. */
  category: string;
  run: (text: string) => string;
}

/** Split into lines, remembering whether the text ended with one. */
function lines(text: string): { rows: string[]; trailing: boolean } {
  const trailing = text.endsWith('\n');
  const rows = (trailing ? text.slice(0, -1) : text).split('\n');
  return { rows, trailing };
}

function join(rows: string[], trailing: boolean): string {
  return rows.join('\n') + (trailing ? '\n' : '');
}

/** Natural order, so item10 follows item9 rather than item1. */
export function sortLines(text: string): string {
  const { rows, trailing } = lines(text);
  return join(
    [...rows].sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }),
    ),
    trailing,
  );
}

export function reverseLines(text: string): string {
  const { rows, trailing } = lines(text);
  return join([...rows].reverse(), trailing);
}

/** Keep the first of each line, in the order they first appeared. */
export function uniqueLines(text: string): string {
  const { rows, trailing } = lines(text);
  return join([...new Set(rows)], trailing);
}

/** Drop lines that are empty or only spaces. */
export function dropBlankLines(text: string): string {
  const { rows, trailing } = lines(text);
  return join(rows.filter((row) => row.trim()), trailing);
}

/** Remove trailing spaces, which are invisible and show up in every diff. */
export function trimTrailing(text: string): string {
  const { rows, trailing } = lines(text);
  return join(rows.map((row) => row.replace(/[ \t]+$/, '')), trailing);
}

/** Join every line into one, collapsing the whitespace at the joins. */
export function joinLines(text: string): string {
  const { rows, trailing } = lines(text);
  return (rows.map((row) => row.trim()).filter(Boolean).join(' ') + (trailing ? '\n' : ''));
}

export function upperCase(text: string): string {
  return text.toUpperCase();
}

export function lowerCase(text: string): string {
  return text.toLowerCase();
}

/**
 * Capitalise the first letter of each word.
 *
 * Only the first letter: forcing the rest to lower case turns `HTTPServer` into
 * `Httpserver`, which is a worse answer than leaving it alone.
 */
export function titleCase(text: string): string {
  return text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/** snake_case and kebab-case to camelCase. */
export function toCamelCase(text: string): string {
  return text.replace(/[_-]+([a-zA-Z0-9])/g, (_whole, letter: string) => letter.toUpperCase());
}

/**
 * camelCase to snake_case.
 *
 * Two boundaries, and the second is the one that is easy to miss: a run of
 * capitals followed by a word starts a new word at the last capital, so
 * `parseHTTPResponse` is `parse_http_response` and not `parse_httpresponse`.
 */
export function toSnakeCase(text: string): string {
  return text
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

/** Number every line, right-aligned so the text still lines up. */
export function numberLines(text: string): string {
  const { rows, trailing } = lines(text);
  const width = String(rows.length).length;
  return join(rows.map((row, index) => `${String(index + 1).padStart(width)}  ${row}`), trailing);
}

/** Pretty-print JSON, or return the text unchanged when it is not JSON. */
export function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2) + (text.endsWith('\n') ? '\n' : '');
  } catch {
    // Leaving it alone beats replacing someone's file with an error message.
    return text;
  }
}

export function minifyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

/** The text as a JSON string literal, quotes and escapes included. */
export function escapeForJson(text: string): string {
  return JSON.stringify(text);
}

export function encodeBase64(text: string): string {
  // Through UTF-8 bytes rather than through btoa directly, which throws on
  // anything above U+00FF.
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(text: string): string {
  try {
    const binary = atob(text.trim());
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return text;
  }
}

/** Every transform, in the order they belong in a menu. */
export const TRANSFORMS: readonly Transform[] = [
  { id: 'text.sort', title: 'Sort lines', category: 'Lines', run: sortLines },
  { id: 'text.reverse', title: 'Reverse lines', category: 'Lines', run: reverseLines },
  { id: 'text.unique', title: 'Remove duplicate lines', category: 'Lines', run: uniqueLines },
  { id: 'text.dropBlank', title: 'Remove blank lines', category: 'Lines', run: dropBlankLines },
  { id: 'text.trimTrailing', title: 'Trim trailing whitespace', category: 'Lines', run: trimTrailing },
  { id: 'text.join', title: 'Join lines', category: 'Lines', run: joinLines },
  { id: 'text.number', title: 'Number lines', category: 'Lines', run: numberLines },
  { id: 'text.upper', title: 'Upper case', category: 'Case', run: upperCase },
  { id: 'text.lower', title: 'Lower case', category: 'Case', run: lowerCase },
  { id: 'text.title', title: 'Title case', category: 'Case', run: titleCase },
  { id: 'text.camel', title: 'To camelCase', category: 'Case', run: toCamelCase },
  { id: 'text.snake', title: 'To snake_case', category: 'Case', run: toSnakeCase },
  { id: 'text.formatJson', title: 'Format JSON', category: 'Convert', run: formatJson },
  { id: 'text.minifyJson', title: 'Minify JSON', category: 'Convert', run: minifyJson },
  { id: 'text.escapeJson', title: 'Escape as a JSON string', category: 'Convert', run: escapeForJson },
  { id: 'text.base64', title: 'Encode as base64', category: 'Convert', run: encodeBase64 },
  { id: 'text.unbase64', title: 'Decode from base64', category: 'Convert', run: decodeBase64 },
];
