/**
 * Which files were open most recently, for the file palette.
 *
 * Ctrl+P with an empty query listed files in the order they were created, which
 * is the order they are least likely to be wanted in. The file you want next is
 * nearly always one of the last few you had open: switching between two files
 * while working on a change is the most common navigation there is, and it was
 * the one thing the palette did not help with.
 *
 * Kept apart from the tab strip on purpose. Tabs are what is open; this is what
 * was recently open, which includes files that have since been closed.
 */

/** Beyond this the tail is older than anything anyone is reaching for. */
export const LIMIT = 20;

/**
 * Move a file to the front, or put it there.
 *
 * Returns the list unchanged when it is already in front, so a caller holding
 * this in React state does not re-render every time the same file is shown.
 */
export function touch(recent: readonly string[], fileId: string): readonly string[] {
  if (!fileId) return recent;
  if (recent[0] === fileId) return recent;
  return [fileId, ...recent.filter((id) => id !== fileId)].slice(0, LIMIT);
}

/** Drop files that no longer exist. */
export function prune(
  recent: readonly string[],
  existing: readonly { id: string }[],
): readonly string[] {
  const alive = new Set(existing.map((file) => file.id));
  const kept = recent.filter((id) => alive.has(id));
  return kept.length === recent.length ? recent : kept;
}

/**
 * Files in the order they were last used, then everything else.
 *
 * Everything else keeps its own order rather than being sorted, because a file
 * never opened has no recency to sort by and the order it was created in is at
 * least stable.
 */
export function order<T extends { id: string }>(
  files: readonly T[],
  recent: readonly string[],
): T[] {
  const byId = new Map(files.map((file) => [file.id, file]));
  const seen = new Set<string>();
  const ordered: T[] = [];

  for (const id of recent) {
    const file = byId.get(id);
    if (file && !seen.has(id)) {
      ordered.push(file);
      seen.add(id);
    }
  }
  for (const file of files) {
    if (!seen.has(file.id)) ordered.push(file);
  }

  return ordered;
}

/**
 * The file to switch to when the palette opens.
 *
 * The second entry, not the first: the first is the file you are looking at.
 * This is what makes Ctrl+P followed by Enter a toggle between two files, which
 * is the gesture the whole list exists for.
 */
export function previous(recent: readonly string[]): string | null {
  return recent[1] ?? null;
}
