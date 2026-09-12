/**
 * Status bar contributions.
 *
 * Each renders from the editor snapshot and returns null when it has nothing
 * to say, so the bar stays quiet rather than showing zeroes.
 */

import { outstanding, scanFile } from '../../todos';
import type { Extension, StatusBarContribution } from '../types';

export const cursorPosition: StatusBarContribution = {
  id: 'status.cursor',
  priority: 10,
  alignment: 'right',
  render: (context) =>
    context.activeFile ? { text: `Ln ${context.line}, Col ${context.column}` } : null,
};

export const selectionSize: StatusBarContribution = {
  id: 'status.selection',
  priority: 20,
  alignment: 'right',
  render: (context) => {
    if (!context.selection) return null;
    const characters = context.selection.length;
    const selectedLines = context.selection.split('\n').length;
    return {
      text: selectedLines > 1 ? `${characters} chars, ${selectedLines} lines` : `${characters} selected`,
      tone: 'accent',
    };
  },
};

export const languageIndicator: StatusBarContribution = {
  id: 'status.language',
  priority: 30,
  alignment: 'right',
  render: (context) =>
    context.language ? { text: context.language, tooltip: 'Language mode' } : null,
};

export const fileSize: StatusBarContribution = {
  id: 'status.size',
  priority: 40,
  alignment: 'right',
  render: (context) => {
    if (!context.activeFile) return null;
    const bytes = new TextEncoder().encode(context.activeFile.content).length;
    const text = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
    return { text, tooltip: 'File size on disk' };
  },
};

export const lineEndings: StatusBarContribution = {
  id: 'status.eol',
  priority: 50,
  alignment: 'right',
  render: (context) => {
    if (!context.activeFile) return null;
    const carriageReturns = (context.activeFile.content.match(/\r\n/g) ?? []).length;
    const newlines = (context.activeFile.content.match(/\n/g) ?? []).length;
    if (newlines === 0) return null;

    // A file with both is worth flagging: it usually means two tools disagreed.
    if (carriageReturns > 0 && carriageReturns < newlines) {
      return { text: 'Mixed EOL', tone: 'warning', tooltip: 'This file has both CRLF and LF endings' };
    }
    return { text: carriageReturns > 0 ? 'CRLF' : 'LF' };
  },
};

export const indentIndicator: StatusBarContribution = {
  id: 'status.indent',
  priority: 60,
  alignment: 'right',
  render: (context) => {
    if (!context.activeFile) return null;
    const indents = context.activeFile.content.match(/^[ \t]+/gm) ?? [];
    if (indents.length === 0) return null;

    const tabs = indents.filter((indent) => indent.includes('\t')).length;
    if (tabs > indents.length / 2) return { text: 'Tabs' };

    // The most common leading-space width is the file's real indent size,
    // which is more useful than whatever the preference happens to say.
    const widths = indents
      .filter((indent) => !indent.includes('\t'))
      .map((indent) => indent.length);
    const gaps = widths.filter((width) => width > 0);
    const smallest = gaps.length ? Math.min(...gaps) : 0;
    return smallest ? { text: `Spaces: ${smallest}` } : null;
  },
};

export const problemCount: StatusBarContribution = {
  id: 'status.todo',
  priority: 15,
  alignment: 'left',
  render: (context) => {
    if (!context.activeFile) return null;
    // The same scan the panel and the linter use, so all three agree on how
    // many notes a file has. Counting the marker word alone also counted
    // `print("TODO")`.
    const count = outstanding(scanFile(context.activeFile));
    return count ? { text: `${count} TODO`, tone: 'warning' } : null;
  },
};

export const STATUS_ITEMS: StatusBarContribution[] = [
  problemCount,
  cursorPosition,
  selectionSize,
  languageIndicator,
  fileSize,
  lineEndings,
  indentIndicator,
];

export const statusPack: Extension = {
  manifest: {
    id: 'codecraft.status',
    name: 'Status Bar',
    description:
      'Caret position, selection size, language, file size, line endings, detected indentation and outstanding TODO count.',
    version: '1.0.0',
    publisher: 'codecraft',
    icon: '📊',
    categories: ['Productivity'],
    activationEvents: ['onStartup'],
  },
  contributes: { statusBar: STATUS_ITEMS },
};
