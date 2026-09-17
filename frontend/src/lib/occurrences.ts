/**
 * Every place a name appears in one file, for editing them all at once.
 *
 * The third member of a family: go-to-definition moves the caret, find-
 * references lists them across the workspace, rename rewrites them after
 * showing you where. This one puts a cursor on each, in the file you are in,
 * so a local change can be typed once.
 *
 * It shares the family's honesty and its limit. Without a language server these
 * are occurrences of the *spelling*, not uses of the thing — so the ones in
 * comments and strings are told apart from the ones in code, and a caller can
 * decide. Multi-cursor editing defaults to code only, because typing into a
 * string you had forgotten was selected is a change you find much later.
 */

import { occurrencesOf, type Region } from './syntax';
import { rulesFor } from './syntax';

export interface Occurrence {
  offset: number;
  length: number;
  region: Region;
}

/** Every whole-word occurrence of `name`, classified. */
export function findAll(text: string, name: string, language: string): Occurrence[] {
  if (!name) return [];
  return occurrencesOf(text, name, rulesFor(language)).map((one) => ({
    offset: one.offset,
    length: name.length,
    region: one.region,
  }));
}

/** Only the ones that are really code. */
export function codeOnly(found: readonly Occurrence[]): Occurrence[] {
  return found.filter((one) => one.region === 'code');
}

/**
 * The occurrence after `offset`, wrapping round to the first.
 *
 * Wrapping, because "add the next one" pressed repeatedly should eventually
 * come back rather than silently stop and leave you wondering whether the key
 * is broken.
 */
export function nextAfter(
  found: readonly Occurrence[],
  offset: number,
): Occurrence | null {
  if (found.length === 0) return null;
  return found.find((one) => one.offset > offset) ?? found[0]!;
}

/** The occurrence before `offset`, wrapping round to the last. */
export function previousBefore(
  found: readonly Occurrence[],
  offset: number,
): Occurrence | null {
  if (found.length === 0) return null;
  const earlier = found.filter((one) => one.offset < offset);
  return earlier[earlier.length - 1] ?? found[found.length - 1]!;
}

/** Which occurrence, if any, the offset is sitting in. */
export function at(found: readonly Occurrence[], offset: number): Occurrence | null {
  return (
    found.find((one) => one.offset <= offset && offset <= one.offset + one.length) ?? null
  );
}

/** How many of each kind, for saying what a selection covers. */
export function summarise(found: readonly Occurrence[]): string {
  if (found.length === 0) return 'No other occurrence in this file.';
  const code = found.filter((one) => one.region === 'code').length;
  const prose = found.length - code;
  const base = code === 1 ? '1 occurrence' : `${code} occurrences`;
  if (prose === 0) return base;
  return `${base}, and ${prose} in comments or strings, left out`;
}
