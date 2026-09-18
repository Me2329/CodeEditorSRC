/**
 * Files you closed and want back.
 *
 * Closing the wrong tab is a one-keystroke mistake, and in a workspace that
 * lives in the browser it is not recoverable from anywhere else: there is no
 * file on disk to open again. So closing keeps the whole file, not a reference
 * to it, and reopening restores what was there rather than what is there now.
 *
 * A stack rather than a list, because "reopen" means the last one, and pressing
 * it repeatedly should walk back through the closings in the order they
 * happened. Bounded, because the contents are held in memory and a long session
 * of opening and closing generated files should not grow without limit.
 */

import type { VirtualFile } from './types';

export interface ClosedFile {
  file: VirtualFile;
  /** Where it was in the tab strip, so it comes back in its own place. */
  index: number;
  at: number;
}

/** How many closings are remembered. Beyond this the oldest is forgotten. */
export const LIMIT = 20;

export function remember(
  stack: readonly ClosedFile[],
  file: VirtualFile,
  index: number,
  at = Date.now(),
): ClosedFile[] {
  // The same file closed twice — reopened and closed again — should not appear
  // twice: the newer closing is the one that describes it.
  const without = stack.filter((entry) => entry.file.id !== file.id);
  return [{ file, index, at }, ...without].slice(0, LIMIT);
}

/** The most recently closed file, and the stack without it. */
export function reopen(
  stack: readonly ClosedFile[],
): { entry: ClosedFile; rest: ClosedFile[] } | null {
  const [entry, ...rest] = stack;
  if (!entry) return null;
  return { entry, rest };
}

/**
 * Put a file back where it was.
 *
 * Its old index unless the list has since shrunk, in which case the end. A file
 * reopened into a position past the end would silently land somewhere else
 * anyway; clamping says so in one line instead.
 */
export function restore(
  files: readonly VirtualFile[],
  entry: ClosedFile,
): VirtualFile[] {
  if (files.some((file) => file.id === entry.file.id)) return [...files];
  const at = Math.min(Math.max(0, entry.index), files.length);
  const next = [...files];
  next.splice(at, 0, entry.file);
  return next;
}

/** Forget a file, for when one with the same id is created again. */
export function forget(stack: readonly ClosedFile[], fileId: string): ClosedFile[] {
  return stack.filter((entry) => entry.file.id !== fileId);
}

export function describe(stack: readonly ClosedFile[]): string {
  const next = stack[0];
  if (!next) return 'No closed files to reopen.';
  return `Reopen ${next.file.name}`;
}
