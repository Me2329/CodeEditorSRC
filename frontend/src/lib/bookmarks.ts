/**
 * Places worth coming back to.
 *
 * A bookmark is a file and a line, and the only interesting question is what
 * happens to it when the file changes underneath. An editor that stores a raw
 * line number quietly lies: insert ten lines at the top and every bookmark
 * below points ten lines short of where it was put, which is worse than having
 * none, because it looks like it worked.
 *
 * So a bookmark also remembers the text of the line it was set on, and is moved
 * rather than trusted. After an edit, the nearest line to the old position that
 * still holds that text wins; if the text is gone entirely, so is the bookmark.
 * Nearest rather than first, because the same line of code appears many times
 * in a file and the one meant is the one that did not move far.
 */

export interface Bookmark {
  fileId: string;
  /** 1-based, as displayed. */
  line: number;
  /** The line's text when the bookmark was set, trimmed. */
  text: string;
}

/** Bookmarks in the order they should be cycled: by file, then by line. */
export function ordered(bookmarks: readonly Bookmark[]): Bookmark[] {
  return [...bookmarks].sort((left, right) => {
    if (left.fileId !== right.fileId) return left.fileId.localeCompare(right.fileId);
    return left.line - right.line;
  });
}

function lineText(content: string, line: number): string {
  return (content.split('\n')[line - 1] ?? '').trim();
}

/** Set one, or clear the one already there. */
export function toggle(
  bookmarks: readonly Bookmark[],
  fileId: string,
  line: number,
  content: string,
): Bookmark[] {
  const existing = bookmarks.find((mark) => mark.fileId === fileId && mark.line === line);
  if (existing) {
    return bookmarks.filter((mark) => mark !== existing);
  }
  return ordered([...bookmarks, { fileId, line, text: lineText(content, line) }]);
}

/** Every bookmark in one file, in line order. */
export function inFile(bookmarks: readonly Bookmark[], fileId: string): Bookmark[] {
  return ordered(bookmarks.filter((mark) => mark.fileId === fileId));
}

export function isMarked(
  bookmarks: readonly Bookmark[],
  fileId: string,
  line: number,
): boolean {
  return bookmarks.some((mark) => mark.fileId === fileId && mark.line === line);
}

/**
 * The next or previous bookmark after a position, wrapping round.
 *
 * Wrapping is right here, unlike moving a line: a bookmark list is a ring you
 * are cycling through, and stopping at the end would mean the key does nothing
 * exactly when you have reached the interesting part.
 */
export function step(
  bookmarks: readonly Bookmark[],
  fileId: string,
  line: number,
  direction: 'next' | 'previous',
): Bookmark | null {
  const all = ordered(bookmarks);
  if (all.length === 0) return null;

  const isAfter = (mark: Bookmark) =>
    mark.fileId !== fileId ? mark.fileId > fileId : mark.line > line;
  const isBefore = (mark: Bookmark) =>
    mark.fileId !== fileId ? mark.fileId < fileId : mark.line < line;

  if (direction === 'next') {
    return all.find(isAfter) ?? all[0]!;
  }
  const earlier = all.filter(isBefore);
  return earlier[earlier.length - 1] ?? all[all.length - 1]!;
}

/**
 * Move a file's bookmarks to wherever their lines went.
 *
 * A bookmark whose text no longer appears is dropped rather than left pointing
 * at whatever now occupies that line number.
 */
export function reconcile(
  bookmarks: readonly Bookmark[],
  fileId: string,
  content: string,
): Bookmark[] {
  const lines = content.split('\n').map((line) => line.trim());
  const kept: Bookmark[] = [];

  for (const mark of bookmarks) {
    if (mark.fileId !== fileId) {
      kept.push(mark);
      continue;
    }
    // An empty line has no text to search for, so it can only be trusted where
    // it is; anything else would match the first blank line in the file.
    if (mark.text === '') {
      if (mark.line <= lines.length) kept.push(mark);
      continue;
    }
    let best: number | null = null;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] !== mark.text) continue;
      const line = index + 1;
      // Strictly closer, so a tie goes to the earlier line. Ties happen a lot
      // — a duplicated line either side of the original — and picking one
      // deterministically matters more than which one it is.
      if (best === null || Math.abs(line - mark.line) < Math.abs(best - mark.line)) {
        best = line;
      }
    }
    if (best !== null) kept.push({ ...mark, line: best });
  }

  return ordered(kept);
}

/** Forget a file's bookmarks, for when the file itself is gone. */
export function forgetFile(bookmarks: readonly Bookmark[], fileId: string): Bookmark[] {
  return bookmarks.filter((mark) => mark.fileId !== fileId);
}

/** Drop bookmarks for files that no longer exist. */
export function prune(bookmarks: readonly Bookmark[], fileIds: readonly string[]): Bookmark[] {
  const alive = new Set(fileIds);
  return bookmarks.filter((mark) => alive.has(mark.fileId));
}

export function describe(bookmarks: readonly Bookmark[]): string {
  if (bookmarks.length === 0) return 'No bookmarks.';
  const files = new Set(bookmarks.map((mark) => mark.fileId)).size;
  const marks = bookmarks.length === 1 ? '1 bookmark' : `${bookmarks.length} bookmarks`;
  return files === 1 ? marks : `${marks} in ${files} files`;
}
