// Visualizations (FR-076): a chart, diagram or notebook spec is laid out by @nova/shared into a
// scene of plain shapes, rendered here as React SVG elements (never as markup strings, so nothing
// in a spec can add elements or script). Every mark with a value has a hit area that shows its
// readout on hover and on keyboard focus, and the same numbers are always one click away as a
// table: nothing is reachable only by hovering.
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  layoutChart,
  layoutDiagram,
  parseVisualizationDoc,
  sceneToSvg,
  type ChartSpec,
  type DiagramSpec,
  type VisualizationDoc,
  type VizItem,
  type VizScene,
  type VizTarget,
} from '@nova/shared';
import { Button, CodeBlock, Icon, rovingIndex } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { Markdown } from '../chat/Markdown.tsx';
import './spaces.css';

/** The file name a downloaded chart gets. */
export function svgFileName(title: string | null | undefined): string {
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'chart'}.svg`;
}

function targetLabel(t: VizTarget): string {
  const rows = t.rows.map((r) => `${r.name}: ${r.value}`).join(', ');
  return rows ? `${t.label}. ${rows}` : t.label;
}

function Item({ it }: { it: VizItem }) {
  switch (it.t) {
    case 'rect':
      return (
        <rect className={it.cls} x={it.x} y={it.y} width={it.w} height={it.h} rx={it.rx ?? 0} />
      );
    case 'path':
      return <path className={it.cls} d={it.d} />;
    case 'line':
      return <line className={it.cls} x1={it.x1} y1={it.y1} x2={it.x2} y2={it.y2} />;
    case 'circle':
      return <circle className={it.cls} cx={it.cx} cy={it.cy} r={it.r} />;
    case 'text':
      return (
        <text className={it.cls} x={it.x} y={it.y} textAnchor={it.anchor}>
          {it.text}
        </text>
      );
  }
}

type Place = 'above' | 'below' | 'right' | 'left';

/**
 * Where the readout sits, in percent of the scene. A tall target (a chart's column band, a pie)
 * gets the box beside it, on the side with more room; a small one (a point, a node) above it, or
 * below it when it is near the top.
 */
export function readoutPlace(
  t: VizTarget,
  scene: VizScene,
): { left: number; top: number; place: Place; shift: string } {
  const pct = (v: number, of: number) => Math.max(0, Math.min(100, (v / of) * 100));
  if (t.h > scene.height * 0.5) {
    const right = t.x + t.w / 2 < scene.width * 0.6;
    return {
      left: pct(right ? t.x + t.w : t.x, scene.width),
      top: pct(t.y, scene.height),
      place: right ? 'right' : 'left',
      shift: right ? '0 0' : '-100% 0',
    };
  }
  const left = pct(t.x + t.w / 2, scene.width);
  const below = t.y < scene.height * 0.25;
  // Shifting the box by the same share of its own width keeps it inside at both edges.
  return {
    left,
    top: pct(below ? t.y + t.h : t.y, scene.height),
    place: below ? 'below' : 'above',
    shift: `-${left}% ${below ? '0' : '-100%'}`,
  };
}

function Readout({ target, scene }: { target: VizTarget; scene: VizScene }) {
  const p = readoutPlace(target, scene);
  return (
    // The same text is the focused target's accessible name, so this copy is visual only.
    <div
      className="viz-readout"
      aria-hidden="true"
      data-place={p.place}
      style={{ left: `${p.left}%`, top: `${p.top}%`, translate: p.shift }}
    >
      <div className="viz-readout-label">{target.label}</div>
      {target.rows.map((r, i) => (
        <div key={i} className="viz-readout-row">
          {r.series !== null ? <span className={`viz-key s${r.series}`} /> : null}
          <span className="viz-readout-value">{r.value}</span>
          <span className="viz-readout-name">{r.name}</span>
        </div>
      ))}
    </div>
  );
}

export function VizSceneView({
  scene,
  title,
  showTitle = true,
}: {
  scene: VizScene;
  title?: string | null;
  /** Off where the surrounding view already shows the title (an artifact's heading). */
  showTitle?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [stopAt, setStop] = useState(0);
  // The one tab stop among the values; a new scene with fewer values starts over at the first.
  const stop = stopAt < scene.targets.length ? stopAt : 0;
  const [showData, setShowData] = useState(false);
  const hits = useRef<SVGSVGElement>(null);
  const tableId = useId();
  const name = title?.trim() || null;
  const label = name ? `${name}. ${scene.summary}` : scene.summary;
  const active = hover ?? focus;
  const target = active !== null ? scene.targets[active] : undefined;
  const viewBox = `0 0 ${scene.width} ${scene.height}`;

  const moveTo = (i: number) => {
    setStop(i);
    hits.current?.querySelectorAll<SVGElement>('.viz-hit')[i]?.focus();
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'Escape') {
      setHover(null);
      setFocus(null);
      return;
    }
    // Left/Right and Up/Down both step through the values; Home and End jump to the ends.
    const at = focus ?? stop;
    const next =
      rovingIndex(e.key, at, scene.targets.length, 'horizontal') ??
      rovingIndex(e.key, at, scene.targets.length, 'vertical');
    if (next === null) return;
    e.preventDefault();
    moveTo(next);
  };

  const download = () => {
    const blob = new Blob([sceneToSvg(scene, name)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = svgFileName(name);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <figure className="viz">
      {name && showTitle ? <figcaption className="viz-title">{name}</figcaption> : null}
      <div className="viz-plot">
        {/* The canvas never grows past the scene's own size, so a small diagram stays small. */}
        <div
          className="viz-canvas"
          style={{ maxWidth: scene.width }}
          onMouseLeave={() => setHover(null)}
        >
          <svg className="viz-art" viewBox={viewBox} role="img" aria-label={label}>
            {scene.items.map((it, i) => (
              <Item key={i} it={it} />
            ))}
          </svg>
          {scene.targets.length ? (
            <svg
              ref={hits}
              className="viz-hits"
              viewBox={viewBox}
              role="group"
              aria-label={`Values in ${name ?? 'the chart'}; use the arrow keys to move`}
              onKeyDown={onKey}
            >
              {scene.targets.map((t, i) => {
                const props = {
                  className: 'viz-hit',
                  tabIndex: i === stop ? 0 : -1,
                  role: 'img',
                  'aria-label': targetLabel(t),
                  'data-active': active === i || undefined,
                  onMouseEnter: () => setHover(i),
                  onFocus: () => {
                    setFocus(i);
                    setStop(i);
                  },
                  onBlur: () => setFocus(null),
                };
                return t.d ? (
                  <path key={i} d={t.d} {...props} />
                ) : (
                  <rect key={i} x={t.x} y={t.y} width={t.w} height={t.h} {...props} />
                );
              })}
            </svg>
          ) : null}
          {target ? <Readout target={target} scene={scene} /> : null}
        </div>
      </div>
      <div className="viz-actions">
        {scene.table ? (
          <Button
            variant="ghost"
            aria-expanded={showData}
            aria-controls={showData ? tableId : undefined}
            onClick={() => setShowData((v) => !v)}
          >
            {showData ? 'Hide data' : 'Show data'}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={download}>
          <Icon name="download" /> Download SVG
        </Button>
      </div>
      {showData && scene.table ? (
        <div
          className="md-table viz-table"
          id={tableId}
          role="region"
          aria-label="Data"
          tabIndex={0}
        >
          <table className="ws-table">
            <caption>{name ?? scene.summary}</caption>
            <thead>
              <tr>
                {scene.table.columns.map((c, i) => (
                  <th key={i} scope="col">
                    {c || 'Category'}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scene.table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) =>
                    j === 0 ? (
                      <th key={j} scope="row">
                        {c}
                      </th>
                    ) : (
                      <td key={j}>{c}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </figure>
  );
}

type Laid = { scene: VizScene; error?: undefined } | { scene?: undefined; error: string };

function lay(make: () => VizScene): Laid {
  try {
    return { scene: make() };
  } catch (err) {
    return { error: errorMessage(err, 'The layout failed.') };
  }
}

/** The connected data a bar or line chart reads, when it reads any. */
export function boundSource(spec: ChartSpec): string | null {
  return (spec.type === 'bar' || spec.type === 'line') && spec.data ? spec.data.source : null;
}

function VizError({ message }: { message: string }) {
  return (
    <p className="viz-note" role="note">
      <Icon name="alert" /> This visualization could not be drawn: {message}
    </p>
  );
}

/**
 * A chart spec; one bound to connected data says where it will be filled in instead. Without a
 * `title` from around it (a document's), the spec's own title names the chart.
 */
export function ChartView({
  spec,
  title,
  showTitle,
}: {
  spec: ChartSpec;
  title?: string | null;
  showTitle?: boolean;
}) {
  const source = boundSource(spec);
  const laid = useMemo(() => (source ? null : lay(() => layoutChart(spec))), [spec, source]);
  const name = title ?? spec.title ?? null;
  if (source)
    return (
      <p className="viz-note" role="note">
        <Icon name="file" /> {name ? `“${name}”: chart` : 'Chart'} of the connected data “{source}”.
        It is drawn when a site is built from this page; connected data is not available here.
      </p>
    );
  if (!laid) return null;
  if (laid.error !== undefined) return <VizError message={laid.error} />;
  return <VizSceneView scene={laid.scene} title={name} showTitle={showTitle} />;
}

export function DiagramView({
  spec,
  title,
  showTitle,
}: {
  spec: DiagramSpec;
  title?: string | null;
  showTitle?: boolean;
}) {
  const laid = useMemo(() => lay(() => layoutDiagram(spec)), [spec]);
  if (laid.error !== undefined) return <VizError message={laid.error} />;
  return <VizSceneView scene={laid.scene} title={title} showTitle={showTitle} />;
}

/** A visualization document: a chart, a diagram, or a notebook of text, charts and diagrams. */
export function VisualizationView({
  doc,
  showTitle = true,
}: {
  doc: VisualizationDoc;
  showTitle?: boolean;
}) {
  switch (doc.kind) {
    case 'chart':
      return <ChartView spec={doc.spec} title={doc.title} showTitle={showTitle} />;
    case 'diagram':
      return <DiagramView spec={doc.spec} title={doc.title} showTitle={showTitle} />;
    case 'notebook':
      return (
        <div className="viz-notebook">
          {doc.title && showTitle ? <h4 className="viz-title">{doc.title}</h4> : null}
          {doc.spec.cells.map((c, i) =>
            c.type === 'markdown' ? (
              <Markdown key={i} text={c.text} />
            ) : c.type === 'chart' ? (
              <ChartView key={i} spec={c.spec} />
            ) : (
              <DiagramView key={i} spec={c.spec} />
            ),
          )}
        </div>
      );
  }
}

/**
 * The body of a `chart` artifact: a visualization document renders as one; any other JSON shows
 * as code, as it did before visualizations existed.
 */
export function ChartArtifactBody({ text, title }: { text: string; title: string }) {
  const doc = useMemo(() => parseVisualizationDoc(text), [text]);
  if (!doc) return <CodeBlock code={text} language="json" label={`Chart data: ${title}`} />;
  // The viewer's heading already names the artifact; a caption only when the chart says more.
  const caption = doc.title ?? (doc.kind === 'chart' ? (doc.spec.title ?? null) : null);
  return <VisualizationView doc={doc} showTitle={!!caption && caption !== title} />;
}
