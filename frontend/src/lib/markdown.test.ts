import { describe, expect, test } from 'vitest';

import { escapeHtml, renderInline, renderMarkdown, safeHref } from './markdown';

describe('escaping', () => {
  test('markup in the source appears as text', () => {
    // A renderer that can emit arbitrary markup is one bad sandbox away from
    // being a problem.
    expect(renderMarkdown('<script>alert(1)</script>')).toContain('&lt;script&gt;');
  });

  test('ampersands are escaped once', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  test('quotes are escaped, because they end attributes', () => {
    expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;');
  });
});

describe('links', () => {
  test('an ordinary link is rendered', () => {
    expect(renderInline('[docs](https://example.com)')).toContain(
      '<a href="https://example.com"',
    );
  });

  test('a relative link is allowed', () => {
    expect(safeHref('./notes.md')).toBe('./notes.md');
  });

  test('a javascript url is refused', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
  });

  test('a refused url leaves the text alone rather than linking it', () => {
    const rendered = renderInline('[click](javascript:alert(1))');

    expect(rendered).not.toContain('<a ');
    expect(rendered).toContain('click');
  });

  test('a data url is refused', () => {
    expect(safeHref('data:text/html,<script>')).toBeNull();
  });

  test('mailto is allowed', () => {
    expect(safeHref('mailto:someone@example.com')).toBe('mailto:someone@example.com');
  });

  test('links open away from the frame', () => {
    // A preview that navigates itself to another site has stopped being one.
    expect(renderInline('[x](https://example.com)')).toContain('rel="noopener noreferrer"');
  });

  test('an image renders as one', () => {
    expect(renderInline('![a cat](https://example.com/cat.png)')).toBe(
      '<img src="https://example.com/cat.png" alt="a cat">',
    );
  });
});

describe('inline markup', () => {
  test('bold and italic', () => {
    expect(renderInline('**bold** and *italic*')).toBe(
      '<strong>bold</strong> and <em>italic</em>',
    );
  });

  test('underscores work too', () => {
    expect(renderInline('__bold__ and _italic_')).toBe('<strong>bold</strong> and <em>italic</em>');
  });

  test('an underscore inside a word is left alone', () => {
    // Otherwise every snake_case identifier turns half a line italic.
    expect(renderInline('my_var_name')).toBe('my_var_name');
  });

  test('strikethrough', () => {
    expect(renderInline('~~gone~~')).toBe('<del>gone</del>');
  });

  test('code spans are escaped and not otherwise touched', () => {
    expect(renderInline('`**not bold**`')).toBe('<code>**not bold**</code>');
  });

  test('an unclosed backtick is text', () => {
    expect(renderInline('a ` b')).toContain('`');
  });

  test('markup inside a code span survives as written', () => {
    expect(renderInline('`<div>`')).toBe('<code>&lt;div&gt;</code>');
  });
});

describe('blocks', () => {
  test('headings by depth', () => {
    expect(renderMarkdown('# One\n\n### Three')).toBe('<h1>One</h1>\n<h3>Three</h3>');
  });

  test('a paragraph', () => {
    expect(renderMarkdown('Just some text.')).toBe('<p>Just some text.</p>');
  });

  test('paragraphs are separated by blank lines', () => {
    expect(renderMarkdown('One.\n\nTwo.')).toBe('<p>One.</p>\n<p>Two.</p>');
  });

  test('a heading right after a paragraph starts a new block', () => {
    expect(renderMarkdown('Text\n# Heading')).toBe('<p>Text</p>\n<h1>Heading</h1>');
  });

  test('a fenced block keeps its language', () => {
    expect(renderMarkdown('```python\nprint(1)\n```')).toBe(
      '<pre><code class="language-python">print(1)</code></pre>',
    );
  });

  test('a fenced block is not markdown', () => {
    expect(renderMarkdown('```\n# not a heading\n```')).toContain('# not a heading');
  });

  test('an unclosed fence runs to the end rather than eating the renderer', () => {
    expect(renderMarkdown('```\nstill code')).toContain('<pre><code>still code');
  });

  test('a horizontal rule', () => {
    expect(renderMarkdown('---')).toBe('<hr>');
  });

  test('an unordered list', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  test('an ordered list', () => {
    expect(renderMarkdown('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
  });

  test('a list ends where the text resumes', () => {
    expect(renderMarkdown('- one\n\nafter')).toBe('<ul><li>one</li></ul>\n<p>after</p>');
  });

  test('list items carry inline markup', () => {
    expect(renderMarkdown('- **bold**')).toContain('<strong>bold</strong>');
  });

  test('a blockquote', () => {
    expect(renderMarkdown('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>');
  });

  test('a blockquote can hold other blocks', () => {
    expect(renderMarkdown('> # heading\n> - item')).toContain('<h1>heading</h1>');
  });

  test('an empty document renders to nothing', () => {
    expect(renderMarkdown('')).toBe('');
  });

  test('trailing blank lines are not paragraphs', () => {
    expect(renderMarkdown('text\n\n\n')).toBe('<p>text</p>');
  });
});

describe('tables', () => {
  test('a pipe table with a divider', () => {
    const rendered = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');

    expect(rendered).toContain('<th>a</th><th>b</th>');
    expect(rendered).toContain('<td>1</td><td>2</td>');
  });

  test('pipes without a divider are a paragraph', () => {
    // Otherwise a line of shell with pipes in it becomes a one-cell table.
    expect(renderMarkdown('cat x | grep y')).toBe('<p>cat x | grep y</p>');
  });

  test('alignment markers are accepted', () => {
    expect(renderMarkdown('| a |\n| :--: |\n| 1 |')).toContain('<th>a</th>');
  });

  test('cells carry inline markup', () => {
    expect(renderMarkdown('| a |\n| --- |\n| `code` |')).toContain('<code>code</code>');
  });
});
