/**
 * Files dragged onto the editor.
 *
 * Importing through a file dialog works and nobody looks for it. Dragging a
 * folder of source onto the window is the gesture people try first, and it did
 * nothing at all.
 *
 * The decisions here are about what to refuse. A workspace lives in the
 * browser's storage, so a dropped 200MB video is not a file that fails to open
 * later, it is a workspace that cannot be saved at all. And a name that already
 * exists has to become a new name rather than silently replacing work.
 */

/** Larger than this is not source, whatever its extension says. */
export const MAX_BYTES = 2 * 1024 * 1024;

/** More than this at once is a folder somebody meant to drop somewhere else. */
export const MAX_FILES = 50;

/** Extensions that are certainly not text, checked before anything is read. */
const BINARY = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svgz', 'avif', 'heic',
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  'zip', 'gz', 'bz2', 'xz', 'tar', '7z', 'rar',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'class', 'jar', 'pyc', 'wasm',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'db', 'sqlite', 'sqlite3', 'pt', 'onnx', 'safetensors',
]);

export interface Droppable {
  name: string;
  size: number;
}

export type Refusal = 'too big' | 'not text' | 'too many' | 'unreadable';

export interface Decision<T extends Droppable> {
  accepted: T[];
  refused: { file: T; because: Refusal }[];
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Which dropped files to take, and why the rest were left.
 *
 * The reasons are returned rather than logged, because a file that silently
 * does not appear is worse than one that appears with an explanation.
 */
export function decide<T extends Droppable>(files: readonly T[]): Decision<T> {
  const accepted: T[] = [];
  const refused: { file: T; because: Refusal }[] = [];

  for (const file of files) {
    if (accepted.length >= MAX_FILES) {
      refused.push({ file, because: 'too many' });
    } else if (BINARY.has(extensionOf(file.name))) {
      refused.push({ file, because: 'not text' });
    } else if (file.size > MAX_BYTES) {
      refused.push({ file, because: 'too big' });
    } else {
      accepted.push(file);
    }
  }

  return { accepted, refused };
}

/**
 * A name nothing else in the workspace has.
 *
 * `util.py` dropped twice becomes `util.py` and `util-2.py`, with the suffix
 * before the extension so the language is still recognised. Replacing the first
 * one would be the other reasonable choice and is the wrong one: a drop is not
 * a decision to overwrite.
 */
export function uniqueName(name: string, taken: readonly string[]): string {
  const existing = new Set(taken);
  if (!existing.has(name)) return name;

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!existing.has(candidate)) return candidate;
  }
  // A thousand files of one name is not a case worth a better answer than a
  // name nobody will collide with.
  return `${stem}-${Date.now()}${extension}`;
}

/**
 * Read the ones that were accepted, skipping any that will not read.
 *
 * A folder dropped on the window arrives as an entry that looks like a file
 * with no type and no size, and reading it rejects. Reading them all at once
 * would let that one rejection lose the whole drop, silently, which is what
 * happened before this existed.
 */
export async function read<T extends Droppable & { text(): Promise<string> }>(
  files: readonly T[],
): Promise<{ read: { name: string; content: string }[]; unreadable: T[] }> {
  const results = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, content: await file.text() };
      } catch {
        return { file, content: null };
      }
    }),
  );

  return {
    read: results
      .filter((entry) => entry.content !== null)
      .map((entry) => ({ name: entry.file.name, content: entry.content as string })),
    unreadable: results.filter((entry) => entry.content === null).map((entry) => entry.file),
  };
}

/** What to tell the user about what was left out. */
export function explain(refused: readonly { because: Refusal }[]): string {
  if (refused.length === 0) return '';

  const counts = new Map<Refusal, number>();
  for (const entry of refused) counts.set(entry.because, (counts.get(entry.because) ?? 0) + 1);

  const parts = [...counts].map(([because, count]) => `${count} ${because}`);
  return `Skipped ${parts.join(', ')}.`;
}
