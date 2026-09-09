/**
 * Text transformations, as pure functions.
 *
 * Every one takes a string and returns a string, which is why they are all
 * testable without an editor and why the host can apply any of them to either a
 * selection or a whole file without knowing what they do.
 */

import type { Extension, TextActionContribution } from '../types';

// ------------------------------------------------------------------- casing

export const toUpper = (text: string) => text.toUpperCase();
export const toLower = (text: string) => text.toLowerCase();

/** Upper-case the first character, leaving an empty string alone. */
function capitalise(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : word;
}

export function toTitleCase(text: string): string {
  return text.replace(/\w\S*/g, (word) => capitalise(word));
}

/** Split an identifier however it is written: camel, snake, kebab or spaced. */
export function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean);
}

export const toCamelCase = (text: string) =>
  words(text)
    .map((word, index) => (index === 0 ? word.toLowerCase() : capitalise(word)))
    .join('');

export const toPascalCase = (text: string) =>
  words(text)
    .map(capitalise)
    .join('');

export const toSnakeCase = (text: string) =>
  words(text)
    .map((word) => word.toLowerCase())
    .join('_');

export const toKebabCase = (text: string) =>
  words(text)
    .map((word) => word.toLowerCase())
    .join('-');

export const toConstantCase = (text: string) =>
  words(text)
    .map((word) => word.toUpperCase())
    .join('_');

// -------------------------------------------------------------------- lines

const lines = (text: string) => text.split('\n');

export const sortLines = (text: string) =>
  lines(text).sort((a, b) => a.localeCompare(b)).join('\n');

export const sortLinesDescending = (text: string) =>
  lines(text).sort((a, b) => b.localeCompare(a)).join('\n');

/** Sort by the number embedded in each line, so `item10` follows `item9`. */
export const sortLinesNaturally = (text: string) =>
  lines(text)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .join('\n');

export const reverseLines = (text: string) => lines(text).reverse().join('\n');

export function uniqueLines(text: string): string {
  const seen = new Set<string>();
  return lines(text)
    .filter((line) => !seen.has(line) && (seen.add(line), true))
    .join('\n');
}

export const removeEmptyLines = (text: string) =>
  lines(text)
    .filter((line) => line.trim() !== '')
    .join('\n');

/** Collapse runs of blank lines to one, the usual style rule. */
export const collapseBlankLines = (text: string) => text.replace(/\n{3,}/g, '\n\n');

export const trimTrailingWhitespace = (text: string) =>
  lines(text)
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');

export function numberLines(text: string): string {
  const all = lines(text);
  const width = String(all.length).length;
  return all.map((line, index) => `${String(index + 1).padStart(width, ' ')}  ${line}`).join('\n');
}

export const shuffleLines = (text: string) => {
  const all = lines(text);
  // Fisher-Yates, walking down so every permutation stays equally likely.
  for (let index = all.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [all[index], all[swap]] = [all[swap]!, all[index]!];
  }
  return all.join('\n');
};

export const joinLines = (text: string) => lines(text).join(' ');

// ------------------------------------------------------------------ encoding

export function toBase64(text: string): string {
  // btoa is byte-oriented, so text has to be encoded first or anything
  // non-ASCII throws.
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes));
}

export function fromBase64(text: string): string {
  const binary = atob(text.trim());
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export const urlEncode = (text: string) => encodeURIComponent(text);
export const urlDecode = (text: string) => decodeURIComponent(text);

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => {
    const table: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return table[character] ?? character;
  });

export const unescapeHtml = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Ampersand last, or `&amp;lt;` would decode twice into `<`.
    .replace(/&amp;/g, '&');

/** Escape for embedding in a source string literal. */
export const escapeString = (text: string) =>
  text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');

// ------------------------------------------------------------------ numbers

export const hexToDecimal = (text: string) =>
  text.replace(/0x[0-9a-fA-F]+/g, (match) => String(parseInt(match, 16)));

export const decimalToHex = (text: string) =>
  text.replace(/\b\d+\b/g, (match) => `0x${Number(match).toString(16).toUpperCase()}`);

/** Sum every number in the text, appended as a trailing comment line. */
export function sumNumbers(text: string): string {
  const found = text.match(/-?\d+(\.\d+)?/g) ?? [];
  const total = found.reduce((sum, value) => sum + Number(value), 0);
  return `${text}\n${total}`;
}

// ------------------------------------------------------------------ wrapping

export function hardWrap(text: string, width = 80): string {
  return lines(text)
    .map((line) => {
      if (line.length <= width) return line;
      const wrapped: string[] = [];
      let current = '';
      for (const word of line.split(' ')) {
        if (current && `${current} ${word}`.length > width) {
          wrapped.push(current);
          current = word;
        } else {
          current = current ? `${current} ${word}` : word;
        }
      }
      if (current) wrapped.push(current);
      return wrapped.join('\n');
    })
    .join('\n');
}

// ---------------------------------------------------------------- the actions

const action = (
  id: string,
  title: string,
  category: string,
  transform: (text: string) => string,
): TextActionContribution => ({ id, title, category, transform });

export const TEXT_ACTIONS: TextActionContribution[] = [
  action('text.upper', 'Upper Case', 'Case', toUpper),
  action('text.lower', 'Lower Case', 'Case', toLower),
  action('text.title', 'Title Case', 'Case', toTitleCase),
  action('text.camel', 'camelCase', 'Case', toCamelCase),
  action('text.pascal', 'PascalCase', 'Case', toPascalCase),
  action('text.snake', 'snake_case', 'Case', toSnakeCase),
  action('text.kebab', 'kebab-case', 'Case', toKebabCase),
  action('text.constant', 'CONSTANT_CASE', 'Case', toConstantCase),

  action('lines.sort', 'Sort Lines', 'Lines', sortLines),
  action('lines.sortDescending', 'Sort Lines Descending', 'Lines', sortLinesDescending),
  action('lines.sortNatural', 'Sort Lines Naturally', 'Lines', sortLinesNaturally),
  action('lines.reverse', 'Reverse Lines', 'Lines', reverseLines),
  action('lines.unique', 'Remove Duplicate Lines', 'Lines', uniqueLines),
  action('lines.removeEmpty', 'Remove Empty Lines', 'Lines', removeEmptyLines),
  action('lines.collapseBlank', 'Collapse Blank Lines', 'Lines', collapseBlankLines),
  action('lines.trimTrailing', 'Trim Trailing Whitespace', 'Lines', trimTrailingWhitespace),
  action('lines.number', 'Number Lines', 'Lines', numberLines),
  action('lines.shuffle', 'Shuffle Lines', 'Lines', shuffleLines),
  action('lines.join', 'Join Lines', 'Lines', joinLines),
  action('lines.wrap', 'Hard Wrap at 80', 'Lines', (text) => hardWrap(text, 80)),

  action('encode.base64', 'Encode Base64', 'Encoding', toBase64),
  action('encode.base64Decode', 'Decode Base64', 'Encoding', fromBase64),
  action('encode.url', 'URL Encode', 'Encoding', urlEncode),
  action('encode.urlDecode', 'URL Decode', 'Encoding', urlDecode),
  action('encode.html', 'Escape HTML', 'Encoding', escapeHtml),
  action('encode.htmlDecode', 'Unescape HTML', 'Encoding', unescapeHtml),
  action('encode.string', 'Escape String Literal', 'Encoding', escapeString),

  action('number.hexToDecimal', 'Hex to Decimal', 'Numbers', hexToDecimal),
  action('number.decimalToHex', 'Decimal to Hex', 'Numbers', decimalToHex),
  action('number.sum', 'Sum Numbers', 'Numbers', sumNumbers),
];

export const textToolkit: Extension = {
  manifest: {
    id: 'codecraft.text-toolkit',
    name: 'Text Toolkit',
    description:
      'Thirty transformations for the selection or the whole file: casing, line operations, encoding and number conversion.',
    version: '1.0.0',
    publisher: 'codecraft',
    icon: '🔤',
    categories: ['Formatters', 'Productivity'],
    activationEvents: ['onStartup'],
  },
  contributes: { textActions: TEXT_ACTIONS },
};
