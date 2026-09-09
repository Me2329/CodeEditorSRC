/**
 * Formatters and language configuration.
 *
 * The formatters here are deliberately modest. A real formatter for a language
 * needs that language's parser, and shipping a half-correct one that mangles
 * valid code is worse than shipping none. What is safe without a parser is
 * whitespace and structure that the grammar cannot argue with, so that is what
 * these do.
 */

import type {
  Extension,
  FormatOptions,
  FormatterContribution,
  LanguageConfiguration,
} from '../types';

/**
 * Re-indent JSON by walking the text and tracking depth.
 *
 * Written by hand rather than `JSON.parse` then `JSON.stringify` because that
 * round trip silently reorders nothing but does destroy anything the parser
 * rejects: a file with one trailing comma comes back as an exception rather
 * than formatted text. This version reformats what it can and leaves the rest.
 */
export function formatJson(text: string, options: FormatOptions): string {
  const indent = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
  let depth = 0;
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;

    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    switch (character) {
      case '"':
        inString = true;
        output += character;
        break;
      case '{':
      case '[':
        depth += 1;
        output += `${character}\n${indent.repeat(depth)}`;
        break;
      case '}':
      case ']':
        depth = Math.max(0, depth - 1);
        output += `\n${indent.repeat(depth)}${character}`;
        break;
      case ',':
        output += `,\n${indent.repeat(depth)}`;
        break;
      case ':':
        output += ': ';
        break;
      default:
        // Existing whitespace outside strings carries no meaning in JSON and
        // would fight the indentation being applied.
        if (!/\s/.test(character)) output += character;
    }
  }

  // An empty object or array picks up a newline it should not have.
  return output.replace(/\{\s+\}/g, '{}').replace(/\[\s+\]/g, '[]');
}

export const jsonFormatter: FormatterContribution = {
  id: 'format.json',
  language: 'json',
  format: formatJson,
};

/** Convert leading tabs to spaces, or the reverse, consistently. */
export function normaliseIndentation(text: string, options: FormatOptions): string {
  const unit = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';

  return text
    .split('\n')
    .map((line) => {
      const match = /^[ \t]+/.exec(line);
      if (!match) return line;

      const leading = match[0];
      // Count in indentation levels, not characters, so a mixed file lands on
      // the same structure it looked like it had.
      const levels = options.insertSpaces
        ? Math.round(
            (leading.split('\t').length - 1) + leading.replace(/\t/g, '').length / options.tabSize,
          )
        : Math.round(
            (leading.split('\t').length - 1) + leading.replace(/\t/g, '').length / options.tabSize,
          );
      return unit.repeat(levels) + line.slice(leading.length);
    })
    .join('\n');
}

export const whitespaceFormatter: FormatterContribution = {
  id: 'format.whitespace',
  language: '*',
  format: (text, options) =>
    // Trailing whitespace, consistent indentation, and exactly one final
    // newline: three things every style guide agrees on.
    `${normaliseIndentation(text, options)
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/\n+$/, '')}\n`,
};

// ------------------------------------------------------- language configuration

export const LANGUAGE_CONFIGURATIONS: LanguageConfiguration[] = [
  {
    language: 'python',
    lineComment: '#',
    blockComment: ['"""', '"""'],
    brackets: [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ],
    indentAfter: /:\s*$/,
    dedentBefore: /^\s*(return|pass|break|continue|raise)\b/,
  },
  {
    language: 'rust',
    lineComment: '//',
    blockComment: ['/*', '*/'],
    brackets: [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
      ['<', '>'],
    ],
    indentAfter: /\{\s*$/,
  },
  {
    language: 'cpp',
    lineComment: '//',
    blockComment: ['/*', '*/'],
    brackets: [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ],
    indentAfter: /\{\s*$/,
  },
  {
    language: 'typescript',
    lineComment: '//',
    blockComment: ['/*', '*/'],
    brackets: [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ],
    indentAfter: /[{([]\s*$/,
  },
  {
    language: 'javascript',
    lineComment: '//',
    blockComment: ['/*', '*/'],
    brackets: [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ],
    indentAfter: /[{([]\s*$/,
  },
  {
    language: 'go',
    lineComment: '//',
    blockComment: ['/*', '*/'],
    brackets: [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ],
    indentAfter: /\{\s*$/,
  },
  {
    language: 'shell',
    lineComment: '#',
    brackets: [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ],
    indentAfter: /\b(then|do|else|in)\s*$/,
    dedentBefore: /^\s*(fi|done|esac|else|elif)\b/,
  },
  {
    language: 'sql',
    lineComment: '--',
    blockComment: ['/*', '*/'],
    brackets: [['(', ')']],
  },
  {
    language: 'lua',
    lineComment: '--',
    blockComment: ['--[[', ']]'],
    brackets: [
      ['(', ')'],
      ['{', '}'],
    ],
    indentAfter: /\b(then|do|function|else)\s*$/,
    dedentBefore: /^\s*(end|else|elseif|until)\b/,
  },
  {
    language: 'ruby',
    lineComment: '#',
    blockComment: ['=begin', '=end'],
    brackets: [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ],
    indentAfter: /\b(do|then)\s*$|\b(def|class|module|if|unless|while)\b.*$/,
    dedentBefore: /^\s*(end|else|elsif|rescue|ensure)\b/,
  },
];

export const formatPack: Extension = {
  manifest: {
    id: 'codecraft.format',
    name: 'Format Pack',
    description:
      'A JSON formatter that survives malformed input, whitespace normalisation for every language, and comment and bracket configuration for ten languages.',
    version: '1.0.0',
    publisher: 'codecraft',
    icon: '📐',
    categories: ['Formatters'],
    activationEvents: ['onStartup'],
  },
  contributes: {
    formatters: [jsonFormatter, whitespaceFormatter],
    languages: LANGUAGE_CONFIGURATIONS,
  },
};
