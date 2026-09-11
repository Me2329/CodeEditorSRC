/**
 * Local history: what a file looked like a few minutes ago.
 *
 * There is no git here. A workspace lives in the browser, and the ways to lose
 * an afternoon are ordinary ones: an assistant rewrite that replaced more than
 * it should have, a find-and-replace across every file, a paste over a
 * selection that turned out to be the whole buffer. Undo covers the first few
 * seconds of that and nothing after a reload.
 *
 * So the editor keeps snapshots. The design is mostly about what *not* to keep:
 *
 *   - A snapshot per keystroke is a memory leak that also makes the list
 *     useless to read. Edits close together in time collapse into one.
 *   - A snapshot identical to the one before it tells the user nothing, so it
 *     is not recorded at all.
 *   - History that grows without limit eventually fills the storage quota and
 *     takes the workspace itself down with it. Both the per-file count and the
 *     total size are bounded, and the oldest goes first.
 *
 * Everything here is pure except the two storage functions, so the policy can
 * be tested without a browser.
 */

import type { VirtualFile } from './types';

/** Why a snapshot was taken. Shown in the list, because "why" is the thing
 *  that lets someone recognise the revision they are looking for. */
export type RevisionReason = 'edit' | 'run' | 'restore' | 'assistant' | 'replace';

export interface Revision {
  id: string;
  fileId: string;
  /** Epoch milliseconds. */
  at: number;
  content: string;
  reason: RevisionReason;
}

/** Revisions per file id, newest first. */
export type History = Readonly<Record<string, readonly Revision[]>>;

export const EMPTY_HISTORY: History = {};

/** Two edits closer together than this are the same edit as far as the list is
 *  concerned. Long enough that typing a function produces one entry, short
 *  enough that going to lunch and coming back produces two. */
export const COALESCE_MS = 45_000;

/** Beyond this a file's own history is the noise it is meant to cut through. */
export const PER_FILE_LIMIT = 40;

/** Roughly a megabyte and a half of source, which localStorage will hold
 *  alongside a workspace without the browser refusing the write. */
export const BYTE_BUDGET = 1_500_000;

const STORAGE_KEY = 'codecraft.history.v1';

// Two snapshots can land in the same millisecond; the counter keeps their ids
// distinct without pulling in a uuid library for something nobody reads.
let sequence = 0;

function newId(at: number): string {
  sequence += 1;
  return `${at.toString(36)}-${sequence.toString(36)}`;
}

export interface RecordRequest {
  fileId: string;
  content: string;
  reason: RevisionReason;
  /** Injected rather than read from the clock, so coalescing is testable. */
  at?: number;
}

/**
 * Add a snapshot, or decline to.
 *
 * Returns the history unchanged when there is nothing worth recording, so a
 * caller holding it in React state re-renders only when something happened.
 */
export function record(history: History, request: RecordRequest): History {
  const at = request.at ?? Date.now();
  const existing = history[request.fileId] ?? [];
  const newest = existing[0];

  // Nothing changed. Recording it would fill the list with entries that all
  // diff to nothing.
  if (newest && newest.content === request.content) return history;

  const revision: Revision = {
    id: newId(at),
    fileId: request.fileId,
    at,
    content: request.content,
    reason: request.reason,
  };

  // Typing produces a snapshot request per pause; collapsing the recent ones
  // keeps "20 minutes ago" meaning a place worth going back to. Only ordinary
  // edits collapse: a run, a restore or an assistant rewrite is a landmark and
  // keeps its own entry even if it lands a second after an edit.
  const coalesces =
    newest !== undefined &&
    newest.reason === 'edit' &&
    request.reason === 'edit' &&
    at - newest.at < COALESCE_MS;

  const kept = coalesces ? existing.slice(1) : existing;
  return trim({ ...history, [request.fileId]: [revision, ...kept] });
}

/** Snapshots for one file, newest first. */
export function revisionsFor(history: History, fileId: string): readonly Revision[] {
  return history[fileId] ?? [];
}

export function revisionById(history: History, id: string): Revision | null {
  for (const revisions of Object.values(history)) {
    const found = revisions.find((revision) => revision.id === id);
    if (found) return found;
  }
  return null;
}

/** Total characters held, which is what the storage quota actually counts. */
export function totalBytes(history: History): number {
  let total = 0;
  for (const revisions of Object.values(history)) {
    for (const revision of revisions) total += revision.content.length;
  }
  return total;
}

/**
 * Enforce both limits, oldest first.
 *
 * The global budget is spent across every file rather than per file, because a
 * workspace with one enormous file and nine small ones should not reserve a
 * tenth of the space for each. The cost is that editing one large file can age
 * out another file's history; the alternative is refusing to record anything
 * once one file has filled its share, which is worse.
 */
export function trim(
  history: History,
  perFile = PER_FILE_LIMIT,
  budget = BYTE_BUDGET,
): History {
  const capped: Record<string, Revision[]> = {};
  for (const [fileId, revisions] of Object.entries(history)) {
    if (revisions.length > 0) capped[fileId] = revisions.slice(0, perFile);
  }

  let total = 0;
  for (const revisions of Object.values(capped)) {
    for (const revision of revisions) total += revision.content.length;
  }
  if (total <= budget) return capped;

  // Oldest across the whole workspace, so what goes is what is least likely to
  // be wanted rather than whichever file happens to be sorted last.
  const oldestFirst = Object.values(capped)
    .flat()
    .sort((left, right) => left.at - right.at);

  const dropped = new Set<string>();
  for (const revision of oldestFirst) {
    if (total <= budget) break;
    dropped.add(revision.id);
    total -= revision.content.length;
  }

  const result: Record<string, Revision[]> = {};
  for (const [fileId, revisions] of Object.entries(capped)) {
    const survivors = revisions.filter((revision) => !dropped.has(revision.id));
    if (survivors.length > 0) result[fileId] = survivors;
  }
  return result;
}

/** Drop one file's history, for when the user asks. */
export function forget(history: History, fileId: string): History {
  if (!(fileId in history)) return history;
  const result = { ...history };
  delete result[fileId];
  return result;
}

export function clearHistory(): History {
  return EMPTY_HISTORY;
}

/**
 * File ids with history but no file.
 *
 * Deleting a file deliberately does not delete its history: deleting the wrong
 * file is exactly the accident this module exists for, and the content is the
 * only copy left. The panel offers these back rather than hiding them.
 */
export function orphaned(history: History, files: readonly VirtualFile[]): string[] {
  const alive = new Set(files.map((file) => file.id));
  return Object.keys(history).filter((fileId) => !alive.has(fileId));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "4 min ago". Relative, because the absolute time of a snapshot taken twenty
 *  minutes ago is not what anyone is scanning the list for. */
export function describeAge(at: number, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.floor(elapsed / DAY);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function describeReason(reason: RevisionReason): string {
  switch (reason) {
    case 'run':
      return 'before running';
    case 'restore':
      return 'before restoring';
    case 'assistant':
      return 'before an assistant edit';
    case 'replace':
      return 'before replace all';
    default:
      return 'edited';
  }
}

// ------------------------------------------------------------------ storage

function isRevision(value: unknown): value is Revision {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.fileId === 'string' &&
    typeof candidate.at === 'number' &&
    Number.isFinite(candidate.at) &&
    typeof candidate.content === 'string' &&
    typeof candidate.reason === 'string'
  );
}

/**
 * Read what was stored, discarding anything that does not look like a
 * revision. Stored data outlives the code that wrote it; a shape change should
 * cost the user their history, not their session.
 */
export function loadHistory(): History {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_HISTORY;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_HISTORY;

    const result: Record<string, Revision[]> = {};
    for (const [fileId, revisions] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(revisions)) continue;
      const valid = revisions.filter(isRevision);
      if (valid.length > 0) {
        result[fileId] = valid.sort((left, right) => right.at - left.at);
      }
    }
    return trim(result);
  } catch {
    return EMPTY_HISTORY;
  }
}

/**
 * Write, and give up quietly if the quota refuses.
 *
 * A failed history write must never be what stops someone editing, so the
 * fallback is to halve the budget and try once more, then stop trying. Losing
 * old snapshots is the intended outcome of running out of room.
 */
export function saveHistory(history: History): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(trim(history, Math.floor(PER_FILE_LIMIT / 4), Math.floor(BYTE_BUDGET / 2))),
      );
    } catch {
      // Out of room even for the smaller copy. History is expendable.
    }
  }
}
