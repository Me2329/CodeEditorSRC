/**
 * Back and forward, through places rather than pages.
 *
 * Following a symbol into another file, jumping to a search hit, opening a
 * diagnostic: each of those moves the caret somewhere you did not choose to be,
 * and the thing you want next is usually to go back. Without a stack, going
 * back means remembering which file you were in and roughly which line, which
 * nobody does.
 *
 * The semantics are a browser's. Visiting somewhere new from the middle of the
 * history throws away what was in front, because the alternative is a tree and
 * nobody has ever wanted to navigate one of those with two keys.
 *
 * What makes it usable rather than merely correct is the filtering. Every caret
 * movement is a place, and recording them all gives a history of every arrow
 * key ever pressed. Only a jump counts: a different file, or far enough within
 * the same one to have lost your place.
 */

export interface Place {
  fileId: string;
  /** 1-based, as the editor shows it. */
  line: number;
  column: number;
}

export interface NavigationState {
  /** Oldest first. */
  entries: readonly Place[];
  /** Which entry is current. -1 when there is no history at all. */
  index: number;
}

export const EMPTY: NavigationState = { entries: [], index: -1 };

/**
 * A move within one file shorter than this is not a jump, it is reading.
 *
 * Ten lines is roughly a third of a screen: far enough that going back is worth
 * a key, close enough that scrolling there yourself is not a chore.
 */
export const MIN_JUMP_LINES = 10;

/** Beyond this the far end is older than anything anyone is looking for. */
export const LIMIT = 50;

function samePlace(left: Place, right: Place): boolean {
  return left.fileId === right.fileId && left.line === right.line;
}

/**
 * Whether moving from one place to another is worth remembering.
 *
 * Exported because the editor asks this before it asks anything else, and
 * because it is the rule most likely to want tuning.
 */
export function isJump(from: Place | null, to: Place): boolean {
  if (!from) return true;
  if (from.fileId !== to.fileId) return true;
  return Math.abs(from.line - to.line) >= MIN_JUMP_LINES;
}

export function current(state: NavigationState): Place | null {
  return state.entries[state.index] ?? null;
}

export function canGoBack(state: NavigationState): boolean {
  return state.index > 0;
}

export function canGoForward(state: NavigationState): boolean {
  return state.index >= 0 && state.index < state.entries.length - 1;
}

/**
 * Record a place, if it is somewhere new.
 *
 * Returns the state unchanged when there is nothing to record, so a caller
 * holding this in React state does not re-render on every cursor move.
 */
export function visit(state: NavigationState, place: Place): NavigationState {
  const here = current(state);

  if (here && samePlace(here, place)) return state;

  // Still in the same neighbourhood: update where we are rather than adding an
  // entry, so going back lands where you actually were and not ten lines above.
  if (here && !isJump(here, place)) {
    const entries = [...state.entries];
    entries[state.index] = place;
    return { entries, index: state.index };
  }

  // Anything ahead of the current position is a branch not taken.
  const kept = state.entries.slice(0, state.index + 1);
  const entries = [...kept, place];

  if (entries.length > LIMIT) {
    const dropped = entries.length - LIMIT;
    return { entries: entries.slice(dropped), index: entries.length - dropped - 1 };
  }
  return { entries, index: entries.length - 1 };
}

export function back(state: NavigationState): NavigationState {
  return canGoBack(state) ? { ...state, index: state.index - 1 } : state;
}

export function forward(state: NavigationState): NavigationState {
  return canGoForward(state) ? { ...state, index: state.index + 1 } : state;
}

/**
 * Drop every place in a file that no longer exists.
 *
 * The index follows what it was pointing at when that survives, and otherwise
 * the nearest entry behind it: going back after deleting a file should land
 * somewhere real rather than at the beginning.
 */
export function forget(state: NavigationState, fileId: string): NavigationState {
  if (!state.entries.some((place) => place.fileId === fileId)) return state;

  const survivors: Place[] = [];
  let index = -1;
  state.entries.forEach((place, position) => {
    if (place.fileId === fileId) return;
    survivors.push(place);
    if (position <= state.index) index = survivors.length - 1;
  });

  return { entries: survivors, index: survivors.length ? index : -1 };
}

/** Places for one file, which is what a panel would list. */
export function placesIn(state: NavigationState, fileId: string): Place[] {
  return state.entries.filter((place) => place.fileId === fileId);
}
