// Visualizations (FR-076): chart and diagram specs are validated, laid out into scenes with hover
// targets and a data table, and serialized to static SVG where nothing in a spec becomes markup.
import { describe, expect, it } from 'vitest';
import {
  bindChartData,
  chartSpecSchema,
  foldPie,
  formatCompact,
  layoutChart,
  layoutDiagram,
  niceTicks,
  parseDiagramText,
  parseVisualizationDoc,
  sceneToSvg,
  type ChartSpec,
  type VizScene,
} from '@nova/shared';
import { visualizationDoc } from '../src/index.ts';

const chart = (spec: unknown) => chartSpecSchema.parse(spec);
const classes = (s: VizScene) => s.items.map((i) => i.cls);

describe('chart specs', () => {
  it('rejects mismatched series, too many scatter series and empty pies', () => {
    expect(
      chartSpecSchema.safeParse({
        type: 'bar',
        labels: ['a', 'b'],
        series: [{ name: 's', values: [1] }],
      }).success,
    ).toBe(false);
    expect(
      chartSpecSchema.safeParse({
        type: 'scatter',
        series: [1, 2, 3, 4].map((i) => ({ name: `s${i}`, points: [[1, 2]] })),
      }).success,
    ).toBe(false);
    expect(chartSpecSchema.safeParse({ type: 'pie', labels: ['a'], values: [0] }).success).toBe(
      false,
    );
    expect(
      chartSpecSchema.safeParse({
        type: 'line',
        labels: ['a'],
        series: [{ name: 's', values: [Infinity] }],
      }).success,
    ).toBe(false);
    expect(
      chartSpecSchema.safeParse({
        type: 'bar',
        data: { source: 'x', x: 'a', y: ['b'] },
        labels: ['a'],
      }).success,
    ).toBe(false);
  });

  it('picks round ticks and compact labels', () => {
    expect(niceTicks(0, 87)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(-12, 30)).toEqual([-20, -10, 0, 10, 20, 30]);
    expect(niceTicks(5, 5)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(niceTicks(0, 0)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect([
      formatCompact(1284),
      formatCompact(12_900_000),
      formatCompact(0.5),
      formatCompact(-2500),
    ]).toEqual(['1.28K', '12.9M', '0.5', '-2.5K']);
  });
});

describe('chart layout', () => {
  it('draws grouped bars from one baseline, with a legend and a target per category', () => {
    const s = layoutChart(
      chart({
        type: 'bar',
        labels: ['Q1', 'Q2', 'Q3'],
        series: [
          { name: 'Revenue', values: [10, 20, -5] },
          { name: 'Cost', values: [8, null, 4] },
        ],
        y: { label: 'EUR' },
      }),
    );
    expect(classes(s).filter((c) => c.startsWith('mark s')).length).toBe(2 + 5);
    expect(s.targets.map((t) => t.label)).toEqual(['Q1', 'Q2', 'Q3']);
    expect(s.targets[1]!.rows).toEqual([
      { series: 0, name: 'Revenue', value: '20' },
      { series: 1, name: 'Cost', value: '–' },
    ]);
    expect(s.table).toEqual({
      columns: ['', 'Revenue', 'Cost'],
      rows: [
        ['Q1', '10', '8'],
        ['Q2', '20', ''],
        ['Q3', '-5', '4'],
      ],
    });
    expect(s.items.some((i) => i.t === 'text' && i.text === 'EUR')).toBe(true);
    expect(
      s.items
        .filter((i) => i.t === 'text' && i.cls === 'legend')
        .map((i) => (i as { text: string }).text),
    ).toEqual(['Revenue', 'Cost']);
    // Bars are at most 24px wide.
    for (const it of s.items)
      if (it.t === 'path' && it.cls.startsWith('mark')) expect(it.d).toMatch(/^M/);
    expect(s.summary).toBe('Bar chart of Revenue, Cost over 3 categories');
  });

  it('stacks bars and draws lines with gaps, end dots and end labels', () => {
    const stacked = layoutChart(
      chart({
        type: 'bar',
        stacked: true,
        labels: ['a', 'b'],
        series: [
          { name: 'x', values: [1, 2] },
          { name: 'y', values: [3, 4] },
        ],
      }),
    );
    expect(stacked.summary).toMatch(/^Stacked bar/);
    const line = layoutChart(
      chart({
        type: 'line',
        labels: ['Jan', 'Feb', 'Mar', 'Apr'],
        series: [{ name: 'Visits', values: [100, null, 140, 150] }],
      }),
    );
    const path = line.items.find((i) => i.t === 'path' && i.cls === 'line s0');
    expect(path && path.t === 'path' ? path.d.match(/M/g)?.length : 0).toBe(2);
    expect(line.items.filter((i) => i.t === 'circle')).toHaveLength(1);
    expect(line.items.some((i) => i.t === 'text' && i.cls === 'value' && i.text === '150')).toBe(
      true,
    );
    // One series: no legend box.
    expect(line.items.some((i) => i.cls === 'legend')).toBe(false);
  });

  it('folds pie slices past the seventh into Other and labels wide slices', () => {
    const labels = 'abcdefghij'.split('');
    const folded = foldPie({ type: 'pie', labels, values: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] });
    expect(folded.labels).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'Other']);
    expect(folded.values.at(-1)).toBe(6);
    const s = layoutChart(chart({ type: 'pie', labels: ['Yes', 'No'], values: [3, 1] }));
    expect(s.targets.map((t) => t.rows[0]!.value)).toEqual(['3 (75%)', '1 (25%)']);
    expect(s.targets.every((t) => typeof t.d === 'string')).toBe(true);
    const whole = layoutChart(chart({ type: 'pie', labels: ['All'], values: [5] }));
    expect(whole.items.find((i) => i.t === 'path')).toBeDefined();
  });

  it('plots scatter points with hit areas larger than the marks', () => {
    const s = layoutChart(
      chart({
        type: 'scatter',
        series: [
          {
            name: 'A',
            points: [
              [1, 2],
              [3, 4],
            ],
          },
        ],
        x: { label: 'Height' },
        y: { label: 'Weight' },
      }),
    );
    expect(s.items.filter((i) => i.t === 'circle')).toHaveLength(2);
    expect(s.targets[0]).toMatchObject({ w: 24, h: 24, label: 'A' });
    expect(s.targets[0]!.rows.map((r) => r.name)).toEqual(['Height', 'Weight']);
  });

  it('binds a chart to connected data by column', () => {
    const spec = chart({ type: 'bar', data: { source: 'sales', x: 'month', y: ['total'] } });
    const bound = bindChartData(spec, {
      sales: [
        { month: 'Jan', total: '12' },
        { month: 'Feb', total: 'n/a' },
      ],
    });
    expect(bound).toMatchObject({
      labels: ['Jan', 'Feb'],
      series: [{ name: 'total', values: [12, null] }],
    });
    expect(() => bindChartData(spec, {})).toThrow(/no connected data/);
    const pie: ChartSpec = chart({ type: 'pie', labels: ['a'], values: [1] });
    expect(bindChartData(pie, {})).toBe(pie);
  });
});

describe('diagrams', () => {
  it('parses the flowchart text form, with labels and shapes', () => {
    const spec = parseDiagramText(
      'flowchart right\na[Start] --> b{Ready?}\nb -->|yes| c(Ship)\nb -- not yet --> a %% loop',
    );
    expect(spec).toEqual({
      type: 'flowchart',
      direction: 'right',
      nodes: [
        { id: 'a', label: 'Start', shape: 'box' },
        { id: 'b', label: 'Ready?', shape: 'diamond' },
        { id: 'c', label: 'Ship', shape: 'round' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c', label: 'yes' },
        { from: 'b', to: 'a', label: 'not yet' },
      ],
    });
    const s = layoutDiagram(spec);
    expect(s.items.filter((i) => i.cls === 'node')).toHaveLength(3);
    expect(s.items.filter((i) => i.cls === 'arrow')).toHaveLength(3);
    expect(s.targets.find((t) => t.label === 'Ready?')!.rows.map((r) => r.value)).toEqual([
      'Ship',
      'Start',
    ]);
    expect(s.table!.rows).toContainEqual(['Ready?', 'Ship', 'yes']);
  });

  it('parses sequences and refuses what it does not understand', () => {
    const spec = parseDiagramText(
      'sequence\nparticipant u as User\nu ->> hub: request\nhub -->> u: reply\nhub ->> hub: think',
    );
    expect(spec).toMatchObject({
      type: 'sequence',
      participants: [
        { id: 'u', label: 'User' },
        { id: 'hub', label: 'hub' },
      ],
      messages: [
        { from: 'u', to: 'hub', label: 'request' },
        { reply: true },
        { from: 'hub', to: 'hub' },
      ],
    });
    const s = layoutDiagram(spec);
    expect(s.items.filter((i) => i.cls === 'lifeline')).toHaveLength(2);
    expect(s.items.some((i) => i.cls === 'edge reply')).toBe(true);
    expect(() => parseDiagramText('pie\na')).toThrow(/starts with/);
    expect(() => parseDiagramText('flowchart\na ==> b')).toThrow(/line 2/);
    expect(() => parseDiagramText('sequence\nhello there')).toThrow(/line 2/);
  });

  it('lays out a top-down flowchart with a self loop', () => {
    const s = layoutDiagram({
      type: 'flowchart',
      nodes: [
        { id: 'a', label: 'One' },
        { id: 'b', label: 'Two' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'b' },
      ],
    });
    expect(s.height).toBeGreaterThan(s.width / 2);
    expect(s.summary).toBe('Flowchart with 2 steps and 2 connections');
  });

  it('bends edges that skip a layer or go back around the nodes between', () => {
    const spec = parseDiagramText(
      'flowchart\na[One] --> b[Two] --> c((Three))\na -->|skip| c\nc -- again --> a',
    );
    expect(spec.type === 'flowchart' ? spec.nodes[2] : null).toEqual({
      id: 'c',
      label: 'Three',
      shape: 'round',
    });
    const s = layoutDiagram(spec);
    const curves = s.items.filter((i) => i.t === 'path' && i.cls === 'edge' && i.d.includes('C'));
    expect(curves).toHaveLength(2);
    // The drawing widens to hold the bends and their labels.
    const labels = s.items.filter((i) => i.t === 'text' && i.cls === 'edge-label');
    for (const l of labels) if (l.t === 'text') expect(l.x).toBeLessThan(s.width);
  });
});

describe('static SVG and visualization documents', () => {
  it('escapes every label; no spec text becomes markup', () => {
    const evil = '<script>alert(1)</script>"';
    const s = layoutChart(
      chart({ type: 'bar', labels: [evil], series: [{ name: evil, values: [1] }] }),
    );
    const svg = sceneToSvg(s, `${evil} title`);
    expect(svg).not.toMatch(/<script/);
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" class="nv-viz"/);
    expect(svg).toContain('<title>');
  });

  it('validates a document per kind and refuses data bindings outside sites', () => {
    const doc = visualizationDoc('diagram', 'Flow', undefined, 'flowchart\na --> b');
    expect(doc).toMatchObject({
      type: 'nova.visualization',
      version: 1,
      kind: 'diagram',
      title: 'Flow',
    });
    expect(parseVisualizationDoc(JSON.stringify(doc))).toEqual(doc);
    expect(parseVisualizationDoc('{"type":"bar"}')).toBeNull();
    expect(parseVisualizationDoc('not json')).toBeNull();
    expect(() =>
      visualizationDoc('chart', 'x', { type: 'bar', data: { source: 'a', x: 'b', y: ['c'] } }),
    ).toThrow(/data bindings/);
    expect(() => visualizationDoc('chart', 'x', { type: 'donut' })).toThrow();
    expect(() => visualizationDoc('diagram', 'x', undefined, 'graph\n???')).toThrow(/line 2/);
    expect(() =>
      visualizationDoc('diagram', 'x', { type: 'flowchart', nodes: [], edges: [] }),
    ).toThrow();
    const nb = visualizationDoc('notebook', 'Notes', {
      cells: [
        { type: 'markdown', text: '# Hello' },
        { type: 'chart', spec: { type: 'pie', labels: ['a'], values: [1] } },
        {
          type: 'diagram',
          spec: { type: 'sequence', participants: [{ id: 'a', label: 'A' }], messages: [] },
        },
      ],
    });
    expect(nb.kind).toBe('notebook');
    expect(() =>
      visualizationDoc('notebook', 'x', {
        cells: [{ type: 'chart', spec: { type: 'line', data: { source: 'a', x: 'b', y: ['c'] } } }],
      }),
    ).toThrow(/data bindings/);
  });
});
