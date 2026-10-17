// A page's preview (FR-036, FR-076): Markdown without raw HTML or unsafe links, where ```chart,
// ```diagram and ```nova-table blocks draw (or say why they cannot) and anything else stays code.
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PageMarkdown, parseChartBlock, parseDiagramBlock } from '../src/spaces/PageMarkdown.tsx';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;

describe('PageMarkdown (FR-036, FR-076)', () => {
  it('draws chart and diagram blocks, in text or JSON form', () => {
    render(
      <PageMarkdown
        text={[
          '# Report',
          fence(
            'chart',
            '{"type":"bar","labels":["A","B"],"series":[{"name":"S","values":[1,2]}]}',
          ),
          fence('diagram', 'flowchart right\na[Ask] --> b[Answer]'),
          fence(
            'diagram',
            '{"type":"sequence","participants":[{"id":"u","label":"User"}],"messages":[]}',
          ),
          fence('ts', 'const x = 1;'),
        ].join('\n\n')}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Report' })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Bar chart of S over 2 categories/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Flowchart with 2 steps/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /Sequence diagram with 1 participants/ })).toBeTruthy();
    // Other code stays code.
    expect(document.querySelector('pre.md-pre code.language-ts')?.textContent).toBe(
      'const x = 1;\n',
    );
  });

  it('names a chart by its spec title, which nothing else on the page carries', () => {
    render(
      <PageMarkdown
        text={fence(
          'chart',
          '{"type":"pie","title":"Budget split","labels":["A","B"],"values":[1,2]}',
        )}
      />,
    );
    expect(screen.getByText('Budget split').tagName).toBe('FIGCAPTION');
    expect(screen.getByRole('img', { name: /^Budget split\. Pie chart/ })).toBeTruthy();
  });

  it('notes connected-data tables and charts that are filled in when a site is built', () => {
    render(
      <PageMarkdown
        text={[
          fence('nova-table sales', ''),
          fence('nova-table', 'orders'),
          fence('nova-table', ''),
          fence('chart', '{"type":"bar","data":{"source":"sales","x":"month","y":["total"]}}'),
        ].join('\n\n')}
      />,
    );
    const notes = screen.getAllByRole('note').map((n) => n.textContent);
    expect(notes[0]).toContain(
      'Table from the connected data “sales” (filled in when the site is built).',
    );
    expect(notes[1]).toContain('“orders”');
    expect(notes[2]).toContain('needs a name');
    expect(notes[3]).toContain('connected data “sales”');
  });

  it('shows why a spec cannot be drawn, next to its source', () => {
    render(
      <PageMarkdown
        text={[
          fence('chart', '{"type":"pie","labels":["A"],"values":[1,2]}'),
          fence('chart', '{not json'),
          fence('diagram', 'flowchart\na --> '),
        ].join('\n\n')}
      />,
    );
    const notes = screen.getAllByRole('note').map((n) => n.textContent);
    expect(notes[0]).toContain('This chart could not be drawn: pie needs one value per label');
    expect(notes[1]).toContain('The chart is not valid JSON.');
    expect(notes[2]).toContain('This diagram could not be drawn: line 2');
    // Each one keeps its source on screen as code.
    expect(screen.getAllByLabelText('chart source')).toHaveLength(2);
    expect(screen.getByLabelText('diagram source').textContent).toBe('flowchart\na --> ');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('never renders raw HTML or unsafe links', () => {
    const { container } = render(
      <PageMarkdown
        text={
          '<script>alert(1)</script><img src=x onerror=alert(1)>\n\n[safe](https://example.com) [bad](javascript:alert(1))'
        }
      />,
    );
    expect(container.querySelector('script, img')).toBeNull();
    const safe = screen.getByRole('link', { name: 'safe' });
    expect(safe.getAttribute('target')).toBe('_blank');
    expect(safe.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText('bad').getAttribute('href') ?? '').not.toContain('javascript');
  });

  it('parses blocks on their own', () => {
    expect(parseChartBlock('{"type":"pie","labels":["A"],"values":[3]}').spec?.type).toBe('pie');
    expect(parseDiagramBlock('sequence\na ->> b: hi').spec?.type).toBe('sequence');
    expect(parseDiagramBlock('{oops').error).toBe('The diagram is not valid JSON.');
    expect(parseDiagramBlock('{"type":"flowchart","nodes":[],"edges":[]}').error).toBeTruthy();
    expect(parseDiagramBlock('pie chart').error).toContain('starts with "flowchart" or "sequence"');
  });
});
