/**
 * Walking the diagnostics in a file.
 *
 * The analysis panel lists what is wrong and clicking a row goes there, which
 * is fine for reading and useless while fixing: fixing means going to the next
 * one without taking your hands off the keyboard.
 *
 * Wrapping is deliberate. A key that does nothing at the last problem feels
 * broken, and there is no other obvious meaning for it: coming back to the
 * first one says "that was the end" more clearly than silence does.
 */

/** The next problem after `current`, wrapping to the first. */
export function nextAfter(lines: readonly number[], current: number): number | null {
  const sorted = ordered(lines);
  if (sorted.length === 0) return null;
  return sorted.find((line) => line > current) ?? sorted[0]!;
}

/** The problem before `current`, wrapping to the last. */
export function previousBefore(lines: readonly number[], current: number): number | null {
  const sorted = ordered(lines);
  if (sorted.length === 0) return null;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    if (sorted[index]! < current) return sorted[index]!;
  }
  return sorted[sorted.length - 1]!;
}

/**
 * Sorted, deduplicated, and without the impossible.
 *
 * Two diagnostics on one line are one place to go, and a line number of zero or
 * less is an analyzer that could not work out where something was; jumping
 * there would move the caret somewhere the user cannot see anything wrong.
 */
function ordered(lines: readonly number[]): number[] {
  return [...new Set(lines.filter((line) => line > 0))].sort((left, right) => left - right);
}

/** Where the caret is, among the problems: "2 of 5", or empty. */
export function position(lines: readonly number[], current: number): string {
  const sorted = ordered(lines);
  if (sorted.length === 0) return '';
  const index = sorted.indexOf(current);
  return index === -1 ? `${sorted.length}` : `${index + 1} of ${sorted.length}`;
}
