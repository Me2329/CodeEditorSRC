/**
 * The rename panel, mounted.
 *
 * The library half is checked by calling it. The half that matters here is
 * whether the proposal a person actually sees matches the edit they get: that
 * prose starts unticked, that the warning about it is on screen rather than in
 * a comment in the source, and that the button renames what the list says.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RenamePanel } from './RenamePanel';
import type { RenameEdit } from '../lib/rename';
import type { VirtualFile } from '../lib/types';

const FILES: VirtualFile[] = [
  {
    id: 'a',
    name: 'main.ts',
    language: 'typescript',
    content: [
      'function save(value) {',
      '  // save it to disk',
      '  console.log("save started");',
      '  return save(value);',
      '}',
    ].join('\n'),
  },
  { id: 'b', name: 'other.ts', language: 'typescript', content: 'save(1);' },
];

let container: HTMLDivElement;
let root: Root;

function mount(props: Partial<Parameters<typeof RenamePanel>[0]> = {}) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  act(() => {
    root.render(
      <RenamePanel
        files={FILES}
        name="save"
        language="typescript"
        onApply={onApply}
        onClose={onClose}
        {...props}
      />,
    );
  });
  return { onApply, onClose };
}

function text() {
  return container.textContent ?? '';
}

function checkboxes() {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
}

function button(label: RegExp) {
  return [...container.querySelectorAll('button')].find((node) =>
    label.test(node.textContent ?? ''),
  );
}

beforeEach(() => {
  // Without this React warns on every act(), and the warnings bury the
  // assertions that matter.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('RenamePanel', () => {
  it('lists every occurrence, grouped by file', () => {
    mount();
    expect(text()).toContain('main.ts');
    expect(text()).toContain('other.ts');
    expect(text()).toContain('function save(value) {');
    expect(text()).toContain('// save it to disk');
  });

  it('ticks the code and leaves the prose, and says so on screen', () => {
    mount();
    // Three code occurrences of five: the comment and the string are listed
    // and not selected.
    expect(text()).toContain('3 of 5 selected');
    expect(text()).toContain('1 in comments');
    expect(text()).toContain('1 in strings');
    expect(text()).toContain('occurrences of the spelling rather than uses of the thing');
  });

  it('offers to rename only what is ticked', () => {
    mount();
    expect(button(/^Rename 3$/)).toBeTruthy();
  });

  it('renames what the list says when the button is pressed', () => {
    const { onApply } = mount();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="New name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'store',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => button(/^Rename 3$/)!.click());

    expect(onApply).toHaveBeenCalledTimes(1);
    const [edits, replacement] = onApply.mock.calls[0] as [RenameEdit[], string];
    expect(replacement).toBe('store');
    expect(edits.map((edit) => edit.fileName)).toEqual(['main.ts', 'other.ts']);
    // The comment and the string were not ticked, so they were not touched.
    expect(edits[0]?.content).toContain('// save it to disk');
    expect(edits[0]?.content).toContain('"save started"');
    expect(edits[0]?.content).toContain('function store(value)');
  });

  it('renames prose too once prose is ticked', () => {
    const { onApply } = mount();
    // The second checkbox in the file group is the first occurrence; the
    // comment is the one after it.
    const comment = checkboxes().find(
      (box) => !box.checked && box.getAttribute('aria-label') === null,
    )!;
    act(() => comment.click());

    const input = container.querySelector<HTMLInputElement>('input[aria-label="New name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'store',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => button(/^Rename 4$/)!.click());

    const [edits] = onApply.mock.calls[0] as [RenameEdit[], string];
    expect(edits[0]?.content).toContain('// store it to disk');
  });

  it('refuses a rename to a keyword, and disables the button', () => {
    mount();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="New name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'class',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(text()).toContain('class is a keyword');
    expect(button(/^Rename \d+$/)?.hasAttribute('disabled')).toBe(true);
  });

  it('shows the count on open rather than scolding for not having typed', () => {
    // The box starts holding the old name, so "that is already the name" is
    // the state the panel opens in. Reporting it there would hide the count.
    mount();
    expect(text()).not.toContain('That is already the name');
    expect(text()).toContain('3 of 5 selected');
    expect(button(/^Rename 3$/)?.hasAttribute('disabled')).toBe(true);
  });

  it('closes without renaming when cancelled', () => {
    const { onApply, onClose } = mount();
    act(() => button(/Cancel/)!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('keeps what the reader ticked when the workspace changes underneath', () => {
    // An agent edit or a restore while the panel is up must not silently
    // re-tick the boxes. The default is computed once, on open.
    const { onApply } = mount();
    const comment = checkboxes().find(
      (box) => !box.checked && box.getAttribute('aria-label') === null,
    )!;
    act(() => comment.click());
    expect(button(/^Rename 4$/)).toBeTruthy();

    // Something else edits an unrelated file.
    const edited = [FILES[0]!, { ...FILES[1]!, content: 'save(1);\n// later' }];
    mount({ files: edited });
    expect(button(/^Rename 4$/)).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('says nothing about prose when there is none', () => {
    mount({ files: [FILES[1]!] });
    expect(text()).not.toContain('in comments');
    expect(text()).toContain('1 of 1 selected');
  });
});
