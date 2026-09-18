/**
 * Which files are open, and which one is showing.
 *
 * Kept separate from the file list because open and exists are different
 * things: a workspace can hold twenty files with three of them open, and
 * closing a tab must not delete anything.
 *
 * The logic worth testing is what happens after a close. Every editor picks a
 * neighbour, and picking the wrong one, or nothing, is the kind of small
 * annoyance that is noticed constantly and reported never.
 */

export interface TabState {
  /** File ids, in the order their tabs appear. */
  open: string[];
  /** The file showing, or null when nothing is open. */
  active: string | null;
}

export const EMPTY: TabState = { open: [], active: null };

/**
 * Show a file, opening a tab for it if there is not one already.
 *
 * An already-open file is activated in place rather than moved to the end.
 * Reordering tabs under someone as they navigate makes the strip unusable.
 */
export function open(state: TabState, fileId: string): TabState {
  if (state.open.includes(fileId)) {
    return state.active === fileId ? state : { ...state, active: fileId };
  }
  return { open: [...state.open, fileId], active: fileId };
}

/**
 * Close a tab, choosing what to show next.
 *
 * The one to the right, falling back to the one on the left when the closed tab
 * was last. That is what every editor does, and it is what keeps a run of
 * closes moving in one direction instead of bouncing.
 */
export function close(state: TabState, fileId: string): TabState {
  const index = state.open.indexOf(fileId);
  if (index === -1) return state;

  const remaining = state.open.filter((id) => id !== fileId);
  if (remaining.length === 0) return EMPTY;

  // Closing a tab that was not showing leaves the current one showing.
  if (state.active !== fileId) return { open: remaining, active: state.active };

  const next = remaining[Math.min(index, remaining.length - 1)]!;
  return { open: remaining, active: next };
}

/** Close everything except one tab. */
export function closeOthers(state: TabState, fileId: string): TabState {
  return state.open.includes(fileId) ? { open: [fileId], active: fileId } : state;
}

export function closeAll(): TabState {
  return EMPTY;
}

/**
 * Move a tab to a new position, for drag and drop.
 *
 * The active file is unchanged: reordering is not navigation.
 */
export function move(state: TabState, fileId: string, to: number): TabState {
  const from = state.open.indexOf(fileId);
  if (from === -1) return state;

  const bounded = Math.max(0, Math.min(to, state.open.length - 1));
  if (from === bounded) return state;

  const reordered = [...state.open];
  reordered.splice(from, 1);
  reordered.splice(bounded, 0, fileId);
  return { ...state, active: state.active, open: reordered };
}

/** Step through the open tabs, wrapping at both ends. */
export function cycle(state: TabState, direction: 1 | -1): TabState {
  if (state.open.length === 0) return state;

  const index = state.active ? state.open.indexOf(state.active) : -1;
  const next = (index + direction + state.open.length) % state.open.length;
  return { ...state, active: state.open[next]! };
}

/**
 * Drop tabs for files that no longer exist.
 *
 * A deleted file must not leave a tab pointing at nothing, and if that file was
 * showing, something else has to be.
 */
export function prune(state: TabState, existing: readonly string[]): TabState {
  const alive = new Set(existing);
  const open = state.open.filter((id) => alive.has(id));

  if (open.length === state.open.length && (!state.active || alive.has(state.active))) {
    return state;
  }
  if (open.length === 0) return EMPTY;

  return {
    open,
    active: state.active && alive.has(state.active) ? state.active : open[0]!,
  };
}
