/**
 * Going to where a name was declared.
 *
 * The workspace index already knows every declaration in every file, and the
 * editor already holds that list for the outline and for go-to-symbol. What was
 * missing is the short path: put the caret on a name, press a key, and be
 * where it was declared, in whichever file that is.
 *
 * No language server is involved, so this is name matching and nothing more. It
 * cannot tell two methods called `save` apart, and it does not pretend to: when
 * several declarations share a name, the one in the file you are already in
 * wins, and the rest are offered rather than guessed between.
 */

import type { Symbol as WorkspaceSymbol } from './types';

/**
 * Whether a word is a name worth looking up.
 *
 * The editor decides what a word is, using the language's own rules, which is
 * why this takes one rather than finding it. What it adds is the part the
 * editor does not judge: `42` is a word and is not something to go to.
 */
export function isName(word: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(word);
}

/**
 * Every declaration of a name, the most likely first.
 *
 * Same file before other files, and earlier before later, so the first entry is
 * what a jump should use and the rest are what a chooser should show.
 */
export function declarationsOf(
  symbols: WorkspaceSymbol[],
  name: string,
  currentFile = '',
): WorkspaceSymbol[] {
  if (!name) return [];

  return symbols
    .filter((symbol) => symbol.name === name)
    .sort((left, right) => {
      const mine = Number(right.file === currentFile) - Number(left.file === currentFile);
      if (mine !== 0) return mine;
      if (left.file !== right.file) return left.file.localeCompare(right.file);
      return left.line - right.line;
    });
}

/**
 * Where to go, or nothing.
 *
 * A declaration the caret is already sitting on is not a destination: jumping
 * to the line you are on looks like the key did nothing, so the next
 * declaration elsewhere is a better answer than the one under the cursor.
 */
export function definitionFrom(
  symbols: WorkspaceSymbol[],
  name: string,
  currentFile: string,
  currentLine: number,
): WorkspaceSymbol | null {
  const found = declarationsOf(symbols, name, currentFile);
  if (found.length === 0) return null;

  const elsewhere = found.filter(
    (symbol) => !(symbol.file === currentFile && symbol.line === currentLine),
  );
  return elsewhere[0] ?? null;
}

/** What to say when a name has no declaration, or several. */
export function describeDeclarations(name: string, found: WorkspaceSymbol[]): string {
  if (found.length === 0) return `No declaration of ${name} in this workspace.`;
  if (found.length === 1) return `${name} — ${found[0]?.file}:${found[0]?.line}`;
  return `${found.length} declarations of ${name}; went to ${found[0]?.file}:${found[0]?.line}`;
}
