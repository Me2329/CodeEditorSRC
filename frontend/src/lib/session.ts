/**
 * What you had open, kept across a reload.
 *
 * The workspace itself has always been saved: the files come back. Everything
 * around them did not, so a reload left every file closed, the split gone, the
 * folder you had expanded collapsed again, and the palette offering files in
 * the order they were created. The work survived and the place you were in it
 * did not.
 *
 * Stored apart from the files on purpose. This is all derived state: every part
 * of it can be thrown away and rebuilt by clicking, so a stored session that
 * makes no sense should be dropped rather than repaired. `restore` is written
 * to return something usable from anything at all, including data written by an
 * older version of this code.
 */

export interface Session {
  /** File ids with a tab, in order. */
  open: string[];
  /** The file showing, or empty. */
  active: string;
  /** The file in the second pane, or empty. */
  split: string;
  /** Most recently shown first. */
  recent: string[];
  /** Folder paths that are collapsed. */
  collapsed: string[];
}

export const EMPTY_SESSION: Session = {
  open: [],
  active: '',
  split: '',
  recent: [],
  collapsed: [],
};

const STORAGE_KEY = 'codecraft.session.v1';

/** A list of strings, or nothing. Bounded, because storage is. */
function strings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').slice(0, limit);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Make sense of whatever was stored.
 *
 * Anything unrecognisable becomes the empty session rather than an error: the
 * cost of getting this wrong is that a reload opens no tabs, and the cost of
 * throwing is an editor that will not start.
 */
export function restore(raw: unknown): Session {
  if (typeof raw !== 'object' || raw === null) return EMPTY_SESSION;
  const source = raw as Record<string, unknown>;

  return {
    open: strings(source.open, 100),
    active: text(source.active),
    split: text(source.split),
    recent: strings(source.recent, 50),
    collapsed: strings(source.collapsed, 200),
  };
}

/**
 * Drop everything that refers to a file the workspace no longer has.
 *
 * Ids outlive nothing: a workspace imported over the old one has entirely
 * different ones, and a session pointing into it would open tabs on files that
 * are not there.
 */
export function reconcile(session: Session, fileIds: readonly string[]): Session {
  const alive = new Set(fileIds);
  const open = session.open.filter((id) => alive.has(id));

  return {
    open,
    // The active file has to be one with a tab, or the strip shows nothing
    // selected while the editor shows a file.
    active: open.includes(session.active) ? session.active : (open[0] ?? ''),
    split: alive.has(session.split) && session.split !== session.active ? session.split : '',
    recent: session.recent.filter((id) => alive.has(id)),
    collapsed: session.collapsed,
  };
}

export function loadSession(): Session {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? restore(JSON.parse(raw)) : EMPTY_SESSION;
  } catch {
    return EMPTY_SESSION;
  }
}

export function saveSession(session: Session): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Private browsing or a full quota. Losing where you were is not worth an
    // error, and the files are stored separately and survive regardless.
  }
}
