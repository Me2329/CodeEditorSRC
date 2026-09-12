/**
 * What a keyword means, on hover.
 *
 * The index knows where names were declared. It knows nothing about the words
 * that are part of the language itself, and those are exactly the ones someone
 * learning a language stops on. `yield`, `lambda`, `static`, `async`: each is a
 * word whose meaning is not guessable from its spelling.
 *
 * Deliberately short. A hover is read in the two seconds before the pointer
 * moves, so each entry is one sentence about what the word does, not a manual
 * page. Where a word means different things in different languages, each
 * language gets its own entry rather than one hedged sentence covering both.
 */

import type { Extension, HoverContribution, HoverText } from '../types';

type Entries = Record<string, string>;

const PYTHON: Entries = {
  def: 'Defines a function. The body is everything indented under it.',
  lambda: 'A function written inline, limited to a single expression.',
  yield: 'Produces a value and suspends the function, resuming where it left off when the next value is asked for. A function containing one is a generator.',
  async: 'Defines a coroutine, which may suspend at an `await` while something else runs.',
  await: 'Suspends the coroutine until the awaited thing finishes, letting the event loop run other work meanwhile.',
  with: 'Runs a block with a resource, which is released when the block ends, whether or not it raised.',
  global: 'Declares that a name belongs to the module rather than to this function, so assigning to it changes the module-level one.',
  nonlocal: 'Declares that a name belongs to the enclosing function rather than to this one.',
  assert: 'Raises AssertionError when the condition is false. Removed entirely when Python runs with -O, so never use one for a check that matters.',
  pass: 'Does nothing. It exists because a block cannot be empty.',
  raise: 'Throws an exception. On its own inside an `except`, re-raises the one being handled.',
  finally: 'Runs whether the block succeeded, failed or returned. For cleanup that must happen either way.',
  class: 'Defines a type. The body runs once, at definition time.',
  self: 'The instance a method was called on. It is a convention rather than a keyword, but it is passed as the first argument.',
  None: 'The absence of a value. There is exactly one of it, so `is None` is the way to test for it.',
};

const JAVASCRIPT: Entries = {
  const: 'Binds a name that cannot be reassigned. The value it points at can still be mutated.',
  let: 'Binds a name scoped to the enclosing block, unlike `var`, which is scoped to the function.',
  var: 'Binds a name scoped to the whole enclosing function and hoisted to its top. `let` is almost always what is meant.',
  async: 'Makes a function return a promise, and allows `await` inside it.',
  await: 'Waits for a promise to settle, without blocking the thread.',
  yield: 'Produces a value from a generator function and suspends it until the next value is asked for.',
  this: 'The receiver of the call. In an arrow function it is the enclosing scope’s, which is usually what is wanted.',
  typeof: 'The type of a value as a string. `typeof null` is `"object"`, which is a famous mistake kept for compatibility.',
  instanceof: 'Whether a constructor’s prototype appears in an object’s prototype chain.',
  new: 'Creates an object and runs a constructor against it.',
  static: 'Attaches a member to the class rather than to its instances.',
  export: 'Makes a binding visible to modules that import this one.',
  import: 'Brings a binding in from another module. Hoisted, so the order of imports does not affect when they run.',
  extends: 'Declares that a class inherits from another.',
  finally: 'Runs whether the block succeeded, failed or returned.',
};

const RUST: Entries = {
  fn: 'Defines a function.',
  let: 'Binds a name. Immutable unless followed by `mut`.',
  mut: 'Makes a binding or a reference mutable.',
  impl: 'Attaches methods to a type, or implements a trait for it.',
  trait: 'A set of methods a type can promise to provide.',
  match: 'Branches on the shape of a value, and must cover every case.',
  unsafe: 'Allows the handful of operations the compiler cannot check, such as dereferencing a raw pointer. It does not turn off the borrow checker.',
  move: 'Makes a closure take ownership of what it captures rather than borrowing it.',
  dyn: 'A trait object: the concrete type is decided at run time, through a vtable.',
  where: 'Introduces the bounds on a generic, when writing them inline would be unreadable.',
  async: 'Makes a function return a future, which does nothing until it is awaited.',
  crate: 'The current compilation unit. As a path prefix it means "from the root of this crate".',
};

/**
 * Whether a word on this line is a word in the code.
 *
 * A keyword inside a comment or a string is prose, and explaining it there is
 * noise. This is a heuristic, not a parse: everything before the word is
 * checked for an odd number of quotes and for a comment marker.
 */
export function looksLikeCode(word: string, line: string): boolean {
  const at = line.indexOf(word);
  if (at === -1) return true;

  const before = line.slice(0, at);
  for (const marker of ['#', '//', '--']) {
    if (before.includes(marker)) return false;
  }
  for (const quote of ['"', "'", '`']) {
    if (before.split(quote).length % 2 === 0) return false;
  }
  return true;
}

function explaining(id: string, language: string, entries: Entries): HoverContribution {
  return {
    id,
    language,
    hover(word: string, line: string): HoverText | null {
      const body = entries[word];
      if (!body || !looksLikeCode(word, line)) return null;
      return { title: word, body };
    },
  };
}

export const keywordHelp: Extension = {
  manifest: {
    id: 'codecraft.keywords',
    name: 'Keyword help',
    publisher: 'codecraft',
    version: '1.0.0',
    description: 'Explains the words that are part of the language itself, on hover.',
    activationEvents: ['onStartup'],
  },
  contributes: {
    hovers: [
      explaining('keywords.python', 'python', PYTHON),
      explaining('keywords.javascript', 'javascript', JAVASCRIPT),
      explaining('keywords.typescript', 'typescript', JAVASCRIPT),
      explaining('keywords.rust', 'rust', RUST),
    ],
  },
};

export const KEYWORD_ENTRIES = { PYTHON, JAVASCRIPT, RUST };
