import { describe, expect, it } from 'vitest';

import { splitFencedBlocks } from './AssistantPanel';

describe('splitFencedBlocks', () => {
  it('separates prose from fenced code', () => {
    const segments = splitFencedBlocks(
      'Here is the fix:\n```rust\nfn main() {}\n```\nThat compiles.',
    );

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ kind: 'text', text: 'Here is the fix:' });
    expect(segments[1]).toMatchObject({ kind: 'code', text: 'fn main() {}', language: 'rust' });
    expect(segments[2]).toMatchObject({ kind: 'text', text: 'That compiles.' });
  });

  it('renders an unclosed block so a streaming reply is never blank', () => {
    const segments = splitFencedBlocks('Try this:\n```python\nprint(1)\nprint(2)');

    expect(segments[1]).toMatchObject({ kind: 'code', language: 'python' });
    expect(segments[1]?.text).toBe('print(1)\nprint(2)');
  });

  it('preserves blank lines and indentation inside code', () => {
    const code = 'def f():\n\n    return 1';
    const segments = splitFencedBlocks(`\`\`\`python\n${code}\n\`\`\``);

    expect(segments[0]?.text).toBe(code);
  });

  it('handles a reply with no code at all', () => {
    const segments = splitFencedBlocks('The loop never terminates.');

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: 'text' });
  });

  it('handles several code blocks in one reply', () => {
    const segments = splitFencedBlocks('One:\n```sh\nls\n```\nTwo:\n```sh\npwd\n```');

    const code = segments.filter((segment) => segment.kind === 'code');
    expect(code.map((segment) => segment.text)).toEqual(['ls', 'pwd']);
  });

  it('drops nothing when the reply is empty', () => {
    expect(splitFencedBlocks('')).toEqual([]);
  });

  it('tolerates an indented fence', () => {
    const segments = splitFencedBlocks('Note:\n  ```js\n  const x = 1;\n  ```\ndone');

    expect(segments.some((segment) => segment.kind === 'code')).toBe(true);
  });
});
