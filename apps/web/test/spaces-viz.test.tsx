// Visualizations (FR-076): scenes render as SVG elements with a summary, every value has a hit
// area whose readout shows on hover and on keyboard focus, the numbers are one click away as a
// table, a chart downloads as standalone SVG, and spec text is only ever text. A chart artifact
// that is a visualization document draws; any other JSON still shows as code.
import { act, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  layoutChart,
  layoutDiagram,
  parseDiagramText,
  type ChartSpec,
  type VisualizationDoc,
} from '@nova/shared';
import {
  ChartArtifactBody,
  VisualizationView,
  VizSceneView,
  readoutPlace,
  svgFileName,
} from '../src/spaces/Visualization.tsx';
import { artifactView, inspector, openWith, stubFetch } from './chat-m3-helpers.tsx';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const BAR: ChartSpec = {
  type: 'bar',
  labels: ['Q1', 'Q2', 'Q3'],
  series: [
    { name: 'North', values: [120, 140, 90] },
    { name: 'South', values: [80, null, 110] },
  ],
  y: { label: 'Units' },
};

const doc = (
  spec: VisualizationDoc['spec'],
  kind: VisualizationDoc['kind'],
  title: string | null,
) => JSON.stringify({ type: 'nova.visualization', version: 1, kind, title, spec });

const art = () => screen.getAllByRole('img').find((e) => e.tagName === 'svg')!;
const hits = () => [...document.querySelectorAll<SVGElement>('.viz-hit')];
const readout = () => document.querySelector('.viz-readout');

describe('VizSceneView (FR-076)', () => {
  it('renders a bar chart with its summary, legend and series classes', () => {
    render(<VizSceneView scene={layoutChart(BAR)} title="Sales by quarter" />);
    const svg = screen.getByRole('img', { name: /^Sales by quarter\. Bar chart of North, South/ });
    expect(svg.getAttribute('viewBox')).toBe('0 0 640 360');
    expect(svg.querySelectorAll('path.mark.s0')).toHaveLength(3);
    // A missing value draws no bar.
    expect(svg.querySelectorAll('path.mark.s1')).toHaveLength(2);
    expect(within(svg).getByText('North')).toBeTruthy();
    expect(screen.getByText('Sales by quarter').tagName).toBe('FIGCAPTION');
    expect(hits()).toHaveLength(3);
  });

  it('renders lines, pies, scatter plots and diagrams', () => {
    const { unmount } = render(
      <VizSceneView scene={layoutChart({ ...BAR, type: 'line' })} title="Trend" />,
    );
    expect(art().querySelectorAll('path.line')).toHaveLength(2);
    expect(art().querySelectorAll('circle.dot').length).toBeGreaterThan(0);
    unmount();

    const pie = render(
      <VizSceneView
        scene={layoutChart({ type: 'pie', labels: ['A', 'B', 'C'], values: [50, 30, 20] })}
      />,
    );
    expect(art().querySelectorAll('path.mark.gap')).toHaveLength(3);
    expect(within(art()).getByText('50%')).toBeTruthy();
    // Pie slices are path hit areas.
    expect(hits().every((h) => h.tagName === 'path')).toBe(true);
    pie.unmount();

    const scatter = render(
      <VizSceneView
        scene={layoutChart({
          type: 'scatter',
          series: [
            {
              name: 'Runs',
              points: [
                [1, 2],
                [3, 4],
                [5, 1],
              ],
            },
          ],
        })}
      />,
    );
    expect(art().querySelectorAll('circle.dot.s0')).toHaveLength(3);
    expect(hits()).toHaveLength(3);
    scatter.unmount();

    render(
      <VizSceneView
        scene={layoutDiagram(
          parseDiagramText('flowchart down\na[Start] --> b{Ready?}\nb -->|yes| c(Ship)'),
        )}
        title="Release"
      />,
    );
    const svg = screen.getByRole('img', { name: /Flowchart with 3 steps and 2 connections/ });
    expect(svg.querySelectorAll('.node')).toHaveLength(3);
    expect(within(svg).getByText('yes')).toBeTruthy();
  });

  it('shows a readout on keyboard focus, moves with the arrow keys and hides on Escape', async () => {
    render(<VizSceneView scene={layoutChart(BAR)} title="Sales" />);
    const group = screen.getByRole('group', { name: /Values in Sales/ });
    // One tab stop for all the values.
    expect(hits().filter((h) => h.getAttribute('tabindex') === '0')).toHaveLength(1);
    await userEvent.tab();
    expect(document.activeElement).toBe(hits()[0]);
    expect(hits()[0]!.getAttribute('aria-label')).toBe('Q1. North: 120, South: 80');
    const box = readout()!;
    expect(box.getAttribute('aria-hidden')).toBe('true');
    expect(box.textContent).toContain('Q1');
    // Values lead and names follow, keyed by the series slot.
    const rows = box.querySelectorAll('.viz-readout-row');
    expect(rows[0]!.querySelector('.viz-key')!.className).toContain('s0');
    expect([...rows[0]!.children].map((c) => c.textContent)).toEqual(['', '120', 'North']);

    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(hits()[1]);
    expect(readout()!.textContent).toContain('Q2');
    expect(readout()!.textContent).toContain('–'); // South has no Q2 value
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(hits()[2]);
    await userEvent.keyboard('{Escape}');
    expect(readout()).toBeNull();
    expect(group.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(hits()[0]);
    act(() => (document.activeElement as SVGElement).blur());
    expect(readout()).toBeNull();
  });

  it('shows a readout on hover and hides it when the pointer leaves', async () => {
    render(<VizSceneView scene={layoutChart(BAR)} />);
    await userEvent.hover(hits()[2]!);
    expect(readout()!.textContent).toContain('Q3');
    expect(hits()[2]!.getAttribute('data-active')).toBe('true');
    await userEvent.unhover(document.querySelector('.viz-canvas')!);
    expect(readout()).toBeNull();
  });

  it('places the readout beside a tall target and above or below a small one', () => {
    const scene = layoutChart(BAR);
    const t = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, label: '', rows: [] });
    expect(readoutPlace(t(40, 20, 100, 300), scene).place).toBe('right');
    expect(readoutPlace(t(500, 20, 100, 300), scene)).toMatchObject({
      place: 'left',
      shift: '-100% 0',
    });
    expect(readoutPlace(t(300, 200, 24, 24), scene).place).toBe('above');
    expect(readoutPlace(t(0, 10, 24, 24), scene)).toMatchObject({
      place: 'below',
      left: expect.any(Number),
    });
  });

  it('offers the numbers as a table', async () => {
    render(<VizSceneView scene={layoutChart(BAR)} title="Sales" />);
    const toggle = screen.getByRole('button', { name: 'Show data' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(toggle);
    const table = screen.getByRole('table', { name: 'Sales' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['Category', 'North', 'South']);
    expect(within(table).getByRole('rowheader', { name: 'Q2' })).toBeTruthy();
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    await userEvent.click(screen.getByRole('button', { name: 'Hide data' }));
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('downloads a standalone SVG', async () => {
    const blobs: Blob[] = [];
    vi.stubGlobal(
      'URL',
      Object.assign(Object.create(URL) as object, {
        createObjectURL: vi.fn((b: Blob) => {
          blobs.push(b);
          return 'blob:chart';
        }),
        revokeObjectURL: vi.fn(),
      }),
    );
    const clicks: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push({ href: this.getAttribute('href') ?? '', download: this.download });
    });
    render(<VizSceneView scene={layoutChart(BAR)} title="Sales <Q3>" />);
    await userEvent.click(screen.getByRole('button', { name: 'Download SVG' }));
    expect(clicks).toEqual([{ href: 'blob:chart', download: 'sales-q3.svg' }]);
    const svg = await blobs[0]!.text();
    expect(blobs[0]!.type).toBe('image/svg+xml');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Sales &lt;Q3&gt;');
    expect(svgFileName(null)).toBe('chart.svg');
  });

  it('never turns spec text into markup', () => {
    const evil = '<img src=x onerror="alert(1)">';
    const { container } = render(
      <VizSceneView
        scene={layoutChart({ type: 'bar', labels: [evil], series: [{ name: 'S', values: [1] }] })}
        title={evil}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    // The text shows as text: the caption, and the category label in the chart.
    expect(screen.getAllByText(evil).map((e) => e.tagName)).toEqual(['FIGCAPTION', 'text']);
  });
});

describe('VisualizationView and chart artifacts (FR-076)', () => {
  it('renders a notebook in order: text, chart and diagram', () => {
    render(
      <VisualizationView
        doc={{
          type: 'nova.visualization',
          version: 1,
          kind: 'notebook',
          title: 'Quarter review',
          spec: {
            cells: [
              { type: 'markdown', text: '## Findings\n\nNorth leads.' },
              { type: 'chart', spec: { ...BAR, title: 'Units by region' } },
              {
                type: 'diagram',
                spec: parseDiagramText('sequence\nu ->> h: request\nh -->> u: reply'),
              },
            ],
          },
        }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Quarter review' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Findings' })).toBeTruthy();
    // A notebook chart has no heading of its own: its spec title names it.
    expect(screen.getByRole('img', { name: /^Units by region\. Bar chart/ })).toBeTruthy();
    expect(screen.getByText('Units by region').tagName).toBe('FIGCAPTION');
    expect(screen.getByRole('img', { name: /Sequence diagram with 2 participants/ })).toBeTruthy();
  });

  it('says that a chart bound to connected data is drawn only in a site', () => {
    render(
      <VisualizationView
        doc={{
          type: 'nova.visualization',
          version: 1,
          kind: 'chart',
          title: 'Sales',
          spec: { type: 'line', data: { source: 'sales', x: 'month', y: ['total'] } },
        }}
      />,
    );
    expect(screen.getByRole('note').textContent).toContain('connected data “sales”');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows a calm message when a layout fails', () => {
    // A spec that passed validation but cannot be laid out (the layout throws).
    const broken = { type: 'pie', labels: ['A'], values: [1] } as ChartSpec;
    Object.defineProperty(broken, 'labels', {
      get: () => {
        throw new Error('bad labels');
      },
    });
    render(
      <VisualizationView
        doc={{ type: 'nova.visualization', version: 1, kind: 'chart', title: null, spec: broken }}
      />,
    );
    expect(screen.getByRole('note').textContent).toContain('could not be drawn: bad labels');
  });

  it('ChartArtifactBody draws a visualization and falls back to JSON for anything else', () => {
    const { unmount } = render(
      <ChartArtifactBody text={doc(BAR, 'chart', 'Sales')} title="Sales" />,
    );
    expect(screen.getByRole('img', { name: /^Sales\. Bar chart/ })).toBeTruthy();
    // The artifact viewer already shows the title.
    expect(document.querySelector('figcaption')).toBeNull();
    unmount();

    render(<ChartArtifactBody text={'{"series": [1, 2]}'} title="Raw" />);
    const code = screen.getByLabelText('Chart data: Raw');
    expect(code.tagName).toBe('PRE');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('draws a visualization artifact in the Inspector', async () => {
    stubFetch({
      '/api/v1/artifacts/art1/content': doc(
        { type: 'pie', labels: ['Rent', 'Food'], values: [60, 40] },
        'chart',
        'Budget',
      ),
    });
    await openWith({
      m3: (tid) => ({
        artifacts: [
          artifactView(tid, { kind: 'chart', mime: 'application/json', title: 'Budget' }),
        ],
      }),
    });
    await userEvent.click(await within(inspector()).findByRole('button', { name: /Budget/ }));
    expect(
      await within(inspector()).findByRole('img', { name: /Budget\. Pie chart of 2 parts/ }),
    ).toBeTruthy();
    expect(within(inspector()).getByRole('button', { name: 'Show data' })).toBeTruthy();
  });
});
