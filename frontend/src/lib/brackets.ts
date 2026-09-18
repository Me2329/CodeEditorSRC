/**
 * Matching brackets, and the text between them.
 *
 * Monaco matches brackets itself, and does it well. What it does not do is
 * answer the questions an editor's *commands* need: which pair encloses this
 * offset, what is inside it, and where does the selection go when you ask to
 * expand outwards. Those need a scan that can be reasoned about and tested,
 * rather than a highlight that can only be looked at.
 *
 * The part worth having is that brackets inside comments and strings do not
 * count. A naive matcher walks into `print("(")` and never comes back, and the
 * user sees "no matching bracket" on a line where the brackets plainly match.
 * The comment and string scanner already exists for renaming, so this asks it.
 */

import { regionOf, rulesFor, scan, type Span } from './syntax';

const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
];

const OPENERS = new Map(PAIRS.map(([open, close]) => [open, close]));
const CLOSERS = new Map(PAIRS.map(([open, close]) => [close, open]));

export interface BracketPair {
  /** Offset of the opening bracket. */
  open: number;
  /** Offset of the closing bracket. */
  close: number;
  bracket: string;
}

/** Brackets that are really code, in order. */
function codeBrackets(text: string, spans: readonly Span[]): Array<{ at: number; character: string }> {
  const found: Array<{ at: number; character: string }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (!OPENERS.has(character) && !CLOSERS.has(character)) continue;
    if (regionOf(spans, index) !== 'code') continue;
    found.push({ at: index, character });
  }
  return found;
}

/**
 * The bracket matching the one at `offset`, or null.
 *
 * Works from either end of a pair, because pressing the key on a closing
 * bracket should take you to its opener as readily as the other way round.
 */
export function matchAt(text: string, offset: number, language: string): number | null {
  const character = text[offset];
  if (!character) return null;
  const rules = rulesFor(language);
  const spans = scan(text, rules);
  if (regionOf(spans, offset) !== 'code') return null;

  const brackets = codeBrackets(text, spans);
  const index = brackets.findIndex((one) => one.at === offset);
  if (index === -1) return null;

  if (OPENERS.has(character)) {
    let depth = 0;
    for (let step = index; step < brackets.length; step += 1) {
      const one = brackets[step]!;
      if (one.character === character) depth += 1;
      else if (one.character === OPENERS.get(character)) {
        depth -= 1;
        if (depth === 0) return one.at;
      }
    }
    return null;
  }

  const opener = CLOSERS.get(character)!;
  let depth = 0;
  for (let step = index; step >= 0; step -= 1) {
    const one = brackets[step]!;
    if (one.character === character) depth += 1;
    else if (one.character === opener) {
      depth -= 1;
      if (depth === 0) return one.at;
    }
  }
  return null;
}

/**
 * The innermost pair enclosing `offset`, or null.
 *
 * An offset sitting *on* a bracket counts as inside that bracket's pair, which
 * is what makes "select what encloses me" work when the caret is at the edge.
 */
export function enclosing(text: string, offset: number, language: string): BracketPair | null {
  const spans = scan(text, rulesFor(language));
  const brackets = codeBrackets(text, spans);

  const stack: Array<{ at: number; character: string }> = [];
  let best: BracketPair | null = null;

  for (const one of brackets) {
    if (OPENERS.has(one.character)) {
      stack.push(one);
      continue;
    }
    const opener = CLOSERS.get(one.character)!;
    // Find the nearest unclosed opener of the right kind, dropping anything
    // above it: unbalanced text should still answer for the parts that match.
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index]!.character !== opener) continue;
      const open = stack[index]!;
      stack.length = index;
      if (open.at <= offset && offset <= one.at) {
        // Innermost wins, and a later pair at the same depth is narrower.
        if (!best || open.at > best.open) {
          best = { open: open.at, close: one.at, bracket: open.character };
        }
      }
      break;
    }
  }

  return best;
}

export interface Selection {
  start: number;
  /** Exclusive. */
  end: number;
}

/** What is between the brackets, not counting them. */
export function inside(pair: BracketPair): Selection {
  return { start: pair.open + 1, end: pair.close };
}

/** The brackets and everything between them. */
export function around(pair: BracketPair): Selection {
  return { start: pair.open, end: pair.close + 1 };
}

/**
 * Grow a selection outwards by one bracket pair.
 *
 * From nothing, the inside of what encloses the caret; from exactly an inside,
 * the brackets too; from exactly a pair, the inside of the pair above it. That
 * sequence is what makes the key usable by holding it down: each press is a
 * strictly larger, meaningful region.
 */
export function expand(
  text: string,
  selection: Selection,
  language: string,
): Selection | null {
  const pair = enclosing(text, selection.start, language);
  if (!pair) return null;

  const within = inside(pair);
  const whole = around(pair);

  if (selection.start === within.start && selection.end === within.end) return whole;
  if (selection.start === whole.start && selection.end === whole.end) {
    const outer = enclosing(text, pair.open - 1, language);
    return outer ? inside(outer) : null;
  }
  // Anything else grows to the inside of what encloses it, unless that is not
  // actually bigger than what is already selected.
  if (within.start <= selection.start && selection.end <= within.end) {
    if (within.start === selection.start && within.end === selection.end) return whole;
    return within;
  }
  return whole;
}

/** Every unmatched bracket, which is what a linter would point at. */
export function unbalanced(text: string, language: string): number[] {
  const spans = scan(text, rulesFor(language));
  const brackets = codeBrackets(text, spans);
  const stack: Array<{ at: number; character: string }> = [];
  const loose: number[] = [];

  for (const one of brackets) {
    if (OPENERS.has(one.character)) {
      stack.push(one);
      continue;
    }
    const opener = CLOSERS.get(one.character)!;
    const top = stack[stack.length - 1];
    if (top && top.character === opener) {
      stack.pop();
    } else {
      loose.push(one.at);
    }
  }

  return [...loose, ...stack.map((one) => one.at)].sort((a, b) => a - b);
}
