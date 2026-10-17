import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Markdown } from '../src/chat/Markdown.tsx';
import { Snippet, formatDate } from '../src/chat/SearchPanel.tsx';

afterEach(cleanup);

describe('Markdown (FR-018)', () => {
  it('renders code blocks, inline code and GFM tables', () => {
    const { container } = render(
      <Markdown
        text={
          'Use `npm test`.\n\n```js\nconst a = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n~~old~~'
        }
      />,
    );
    expect(container.querySelector('pre.md-pre code')?.textContent).toBe('const a = 1;\n');
    expect(container.querySelector('pre code')?.className).toBe('language-js');
    expect(container.querySelector('p code')?.textContent).toBe('npm test');
    expect(container.querySelector('.md-table table td')?.textContent).toBe('1');
    expect(container.querySelector('del')?.textContent).toBe('old');
  });

  it('drops unsafe link schemes', () => {
    const { container } = render(<Markdown text={'[x](javascript:alert(1))'} />);
    expect(container.querySelector('a')?.getAttribute('href') ?? '').not.toContain('javascript');
  });
});

describe('search snippets', () => {
  it('highlights only the <mark> marker and treats other markup as text', () => {
    const { container } = render(<Snippet text={'a <b>bold</b> <mark>hit</mark> end'} />);
    expect(container.querySelector('mark')?.textContent).toBe('hit');
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toBe('a <b>bold</b> hit end');
    expect(formatDate('nonsense')).toBe('');
  });
});
