/**
 * Renaming a name everywhere it is used.
 *
 * Go-to-definition and find-references already work on the workspace index,
 * which matches names and nothing more. Rename is the third of that family and
 * the only dangerous one. The other two move the caret: a wrong answer wastes a
 * keystroke. This one edits every file it touches, and a wrong answer is a
 * workspace that no longer compiles, in places nobody was looking.
 *
 * So it does not rename. It proposes a rename, and the proposal is the feature.
 * Every occurrence is listed with its file, its line and what it is part of —
 * code, a comment, or a string — and every one can be taken or left. Comments
 * and strings start unticked, because a name inside prose is usually a mention
 * rather than a use, and occasionally is exactly the thing you meant to change.
 * Nothing is guessed that cannot be seen and undone.
 *
 * The honest limit is unchanged from its two siblings and is stated in the
 * interface rather than buried here: without a language server there is no way
 * to tell one `save` from another. A file's occurrences are occurrences of the
 * spelling. What this adds is that you get to look before anything happens.
 */

import { isKeyword, occurrencesOf, rulesFor, type Region } from './syntax';
import type { VirtualFile } from './types';

/** One occurrence, located well enough to show and to edit. */
export interface RenameSite {
  fileId: string;
  fileName: string;
  /** Offset in the file's text, which is what the edit uses. */
  offset: number;
  /** 1-based, as displayed. */
  line: number;
  column: number;
  /** The whole line, for context in the list. */
  text: string;
  region: Region;
}

export interface FileSites {
  fileId: string;
  fileName: string;
  sites: RenameSite[];
}

export interface RenamePlan {
  name: string;
  replacement: string;
  files: FileSites[];
  /** Every site, flat and in the order they are shown. */
  sites: RenameSite[];
}

/**
 * A rename stops here. A name like `i` in a large workspace is thousands of
 * occurrences, and a list nobody can read is not a confirmation.
 */
export const SITE_LIMIT = 1000;

/**
 * Whether a string can be a name in the languages this editor edits.
 *
 * The intersection rather than the union: a name accepted here has to be legal
 * in every file it might land in, and `$` is a letter in JavaScript and a
 * syntax error in C. Leading digits are out everywhere.
 */
export function isValidName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Why this name cannot be renamed at all, whatever it is renamed to.
 *
 * Separate from `whyNot` so a caller deciding whether to *offer* a rename can
 * ask without supplying a replacement it does not have yet. Matching on the
 * text of `whyNot`'s answer would work until someone reworded it.
 */
export function whyNotRenamable(name: string, language = ''): string | null {
  if (!name) return 'Put the caret on a name first.';
  if (language && isKeyword(name, language)) return `${name} is a keyword, not a name.`;
  return null;
}

/**
 * Why a rename cannot proceed, or null when it can.
 *
 * The keyword checks run in both directions and neither is hypothetical. The
 * caret lands on `def` as easily as on the name beside it, and `def` matches
 * the identifier pattern and occurs in every Python file in the workspace; a
 * rename of it turns every function into a syntax error. Renaming something to
 * a keyword does the same from the other side.
 */
export function whyNot(name: string, replacement: string, language = ''): string | null {
  const beforeTyping = whyNotRenamable(name, language);
  if (beforeTyping) return beforeTyping;
  if (!replacement) return 'Type a new name.';
  if (replacement === name) return `That is already the name.`;
  if (!isValidName(replacement)) {
    return `${replacement} is not a name: letters, digits and underscores, not starting with a digit.`;
  }
  if (language && isKeyword(replacement, language)) {
    return `${replacement} is a keyword; renaming to it would not compile.`;
  }
  return null;
}

/** Line and column for an offset, both 1-based, plus the line's text. */
function locate(text: string, offset: number): { line: number; column: number; text: string } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }
  const newline = text.indexOf('\n', lineStart);
  const lineEnd = newline === -1 ? text.length : newline;
  return { line, column: offset - lineStart + 1, text: text.slice(lineStart, lineEnd) };
}

/**
 * Every place the name occurs, across the workspace, classified.
 *
 * Files are visited in the order given, which is the order they are shown, so
 * the list in the panel matches the list in the explorer.
 */
export function planRename(
  files: readonly VirtualFile[],
  name: string,
  replacement: string,
): RenamePlan {
  const grouped: FileSites[] = [];
  const flat: RenameSite[] = [];

  for (const file of files) {
    if (flat.length >= SITE_LIMIT) break;
    const rules = rulesFor(file.language);
    const found = occurrencesOf(file.content, name, rules);
    if (found.length === 0) continue;

    const sites: RenameSite[] = [];
    for (const one of found) {
      if (flat.length >= SITE_LIMIT) break;
      const where = locate(file.content, one.offset);
      const site: RenameSite = {
        fileId: file.id,
        fileName: file.name,
        offset: one.offset,
        line: where.line,
        column: where.column,
        text: where.text,
        region: one.region,
      };
      sites.push(site);
      flat.push(site);
    }
    if (sites.length > 0) {
      grouped.push({ fileId: file.id, fileName: file.name, sites });
    }
  }

  return { name, replacement, files: grouped, sites: flat };
}

/** A site's identity in the selection, stable across a re-plan. */
export function keyOf(site: RenameSite): string {
  return `${site.fileId}:${site.offset}`;
}

/**
 * What is ticked when the panel opens: the code, and not the prose.
 *
 * A name in a comment is usually a mention of the thing rather than a use of
 * it, and renaming mentions is how a rename turns into a diff nobody can
 * review. They are listed and can be ticked; they are not ticked for you.
 */
export function defaultSelection(plan: RenamePlan): Set<string> {
  return new Set(plan.sites.filter((site) => site.region === 'code').map(keyOf));
}

/** How many of each kind, for the sentence above the list. */
export function countByRegion(sites: readonly RenameSite[]): Record<Region, number> {
  const counts: Record<Region, number> = { code: 0, comment: 0, string: 0 };
  for (const site of sites) counts[site.region] += 1;
  return counts;
}

export interface RenameEdit {
  fileId: string;
  fileName: string;
  content: string;
  /** How many occurrences changed in this file. */
  changed: number;
}

/**
 * The new contents of every file the selection touches.
 *
 * Applied back to front within each file, so that replacing a name with one of
 * a different length does not move the offsets of the sites not yet applied.
 * Files not touched are not returned: an edit list that includes unchanged
 * files would make the history entry claim changes that did not happen.
 */
export function applyRename(
  files: readonly VirtualFile[],
  plan: RenamePlan,
  selection: ReadonlySet<string>,
): RenameEdit[] {
  const edits: RenameEdit[] = [];

  for (const group of plan.files) {
    const chosen = group.sites
      .filter((site) => selection.has(keyOf(site)))
      .sort((left, right) => right.offset - left.offset);
    if (chosen.length === 0) continue;

    const file = files.find((entry) => entry.id === group.fileId);
    if (!file) continue;

    let content = file.content;
    for (const site of chosen) {
      // Guard against a stale plan: if the text moved under us, the name is no
      // longer where the plan says, and writing there would corrupt the file.
      if (content.slice(site.offset, site.offset + plan.name.length) !== plan.name) continue;
      content =
        content.slice(0, site.offset) +
        plan.replacement +
        content.slice(site.offset + plan.name.length);
    }

    if (content !== file.content) {
      edits.push({
        fileId: file.id,
        fileName: file.name,
        content,
        changed: chosen.length,
      });
    }
  }

  return edits;
}

/** What to say once it is done, in the terms the user chose it in. */
export function describeRename(plan: RenamePlan, edits: readonly RenameEdit[]): string {
  const changed = edits.reduce((total, edit) => total + edit.changed, 0);
  if (changed === 0) return `Nothing selected; ${plan.name} is unchanged.`;
  const places = changed === 1 ? '1 occurrence' : `${changed} occurrences`;
  const where = edits.length === 1 ? edits[0]?.fileName : `${edits.length} files`;
  return `Renamed ${plan.name} to ${plan.replacement}: ${places} in ${where}.`;
}
