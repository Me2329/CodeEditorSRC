/**
 * Keyboard shortcuts, as data rather than a chain of if statements.
 *
 * The editor's shortcuts were a sequence of conditionals inside one keydown
 * handler. That works until you want to show them in a menu, let someone change
 * one, or notice that two of them collide, at which point the list has to exist
 * as a value. This is that list.
 *
 * Chords are deliberately not supported. They are the feature that makes a
 * keybinding system four times as complicated, and nothing in this editor needs
 * one.
 */

export interface Binding {
  /** The command this runs, matching a registered command id. */
  command: string;
  /** Normalised: modifiers in a fixed order, then the key. */
  keys: string;
  /** Where it applies. A binding for the editor should not fire in a text box. */
  when?: 'always' | 'editor';
}

/** A keyboard event reduced to the parts that identify a shortcut. */
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Turn an event into a comparable string.
 *
 * Ctrl and Meta are folded together as `mod`, so one binding covers both a
 * Windows keyboard and a Mac one. That is a deliberate simplification: it means
 * a binding cannot distinguish them, which no shortcut here needs to do.
 */
export function describe(event: KeyEventLike): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');

  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  parts.push(key);
  return parts.join('+');
}

/**
 * Parse a written shortcut into the same normalised form.
 *
 * Accepts what people actually type: `Ctrl+Shift+P`, `cmd+p`, `Mod+,`. Returns
 * null for anything that is not a shortcut, so a hand-edited settings file
 * cannot install a binding that can never fire.
 */
export function parse(written: string): string | null {
  const pieces = written
    .split('+')
    .map((piece) => piece.trim().toLowerCase())
    .filter(Boolean);

  if (pieces.length === 0) return null;

  const key = pieces[pieces.length - 1]!;
  const modifiers = new Set(pieces.slice(0, -1));

  // A shortcut that is only modifiers can never fire.
  if (['mod', 'ctrl', 'cmd', 'meta', 'alt', 'option', 'shift'].includes(key)) return null;

  const parts: string[] = [];
  if (modifiers.has('mod') || modifiers.has('ctrl') || modifiers.has('cmd') || modifiers.has('meta'))
    parts.push('mod');
  if (modifiers.has('alt') || modifiers.has('option')) parts.push('alt');
  if (modifiers.has('shift')) parts.push('shift');

  // Multi-character keys keep their canonical casing; `f11` is `F11`.
  parts.push(key.length === 1 ? key : canonicalKey(key));
  return parts.join('+');
}

const NAMED_KEYS = [
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
];

function canonicalKey(key: string): string {
  return NAMED_KEYS.find((named) => named.toLowerCase() === key) ?? key;
}

/** Render for display, in the notation each platform's users expect. */
export function format(keys: string, mac = false): string {
  return keys
    .split('+')
    .map((part) => {
      if (part === 'mod') return mac ? '⌘' : 'Ctrl';
      if (part === 'alt') return mac ? '⌥' : 'Alt';
      if (part === 'shift') return mac ? '⇧' : 'Shift';
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(mac ? '' : '+');
}

/**
 * The shipped bindings.
 *
 * Every command id here must be a command the editor registers, or the shortcut
 * is dead and nothing says so. A test asserts that.
 */
export const DEFAULT_BINDINGS: readonly Binding[] = [
  { command: 'run.execute', keys: 'mod+Enter' },
  { command: 'palette.commands', keys: 'mod+shift+p' },
  { command: 'view.files', keys: 'mod+p' },
  { command: 'view.symbols', keys: 'mod+shift+o' },
  { command: 'view.search', keys: 'mod+shift+f' },
  { command: 'view.settings', keys: 'mod+,' },
  { command: 'view.wrap', keys: 'alt+z' },
  { command: 'view.zen', keys: 'F11' },
  { command: 'edit.format', keys: 'mod+shift+i', when: 'editor' },
];

/**
 * Bindings that would never fire because an earlier one claims the same keys.
 *
 * Worth surfacing rather than resolving silently: a shortcut that does nothing
 * is a bug the user cannot see, and the fix is theirs to choose.
 */
export function conflicts(bindings: readonly Binding[]): { keys: string; commands: string[] }[] {
  const byKeys = new Map<string, string[]>();
  for (const binding of bindings) {
    byKeys.set(binding.keys, [...(byKeys.get(binding.keys) ?? []), binding.command]);
  }

  return [...byKeys.entries()]
    .filter(([, commands]) => commands.length > 1)
    .map(([keys, commands]) => ({ keys, commands }));
}

/** The command bound to an event, or null. First match wins. */
export function resolve(
  event: KeyEventLike,
  bindings: readonly Binding[],
  context: 'always' | 'editor' = 'always',
): string | null {
  const pressed = describe(event);

  const found = bindings.find((binding) => {
    if (binding.keys !== pressed) return false;
    const scope = binding.when ?? 'always';
    return scope === 'always' || scope === context;
  });

  return found?.command ?? null;
}

/** Apply user overrides to the defaults, dropping any that will not parse. */
export function merge(
  defaults: readonly Binding[],
  overrides: Record<string, string>,
): Binding[] {
  const result = defaults.map((binding) => {
    const written = overrides[binding.command];
    if (written === undefined) return binding;

    const parsed = parse(written);
    // An unparseable override leaves the default in place rather than removing
    // the shortcut: silently losing a binding is worse than ignoring a typo.
    return parsed ? { ...binding, keys: parsed } : binding;
  });

  // Overrides for commands with no default still take effect.
  for (const [command, written] of Object.entries(overrides)) {
    if (result.some((binding) => binding.command === command)) continue;
    const parsed = parse(written);
    if (parsed) result.push({ command, keys: parsed });
  }

  return result;
}
