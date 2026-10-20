// M6 spaces API shapes (owned by the spaces area; the web reads them): Spaces and Pages (FR-036),
// Sites (FR-037) and visualizations (FR-076). The visualization part is a dependency-free layout:
// a spec becomes a `VizScene` of plain shapes that the Hub serializes to static SVG (sites, export)
// and the web renders as React elements. Nothing in a spec is ever executed; text is only text.
import { z } from 'zod';

// ==== Spaces and Pages (FR-036) ==================================================================

export const SPACE_AGENT_EDITS = ['propose', 'direct'] as const;
/** How agent edits land: as proposals the user accepts, or as direct (reversible) versions. */
export type SpaceAgentEdits = (typeof SPACE_AGENT_EDITS)[number];
export type PageAuthorKind = 'user' | 'agent';

/** The longest page Nova stores (characters of Markdown). */
export const MAX_PAGE_CHARS = 500_000;

export interface SpaceView {
  id: string;
  name: string;
  description: string | null;
  projectId: string | null;
  agentEdits: SpaceAgentEdits;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PageSummaryView {
  id: string;
  spaceId: string;
  title: string;
  /** The page's file name in a generated site (`<slug>.html`). */
  slug: string;
  position: number;
  version: number;
  updatedBy: PageAuthorKind;
  openComments: number;
  openProposals: number;
  createdAt: string;
  updatedAt: string;
}

export interface PageView extends PageSummaryView {
  content: string;
}

export interface PageVersionView {
  pageId: string;
  version: number;
  title: string;
  authorKind: PageAuthorKind;
  /** The agent's thread for agent edits. */
  authorRef: string | null;
  summary: string | null;
  /** Set when this version restored an earlier one. */
  restoredFrom: number | null;
  /** Set when this version is an accepted proposal. */
  proposalId: string | null;
  size: number;
  createdAt: string;
  /** Only when one version is fetched. */
  content?: string;
}

/** Where a comment points: the whole page, a text range (character offsets) or a block. */
export type CommentAnchor =
  | { kind: 'page' }
  | { kind: 'range'; start: number; end: number; quote: string }
  | { kind: 'block'; index: number; quote: string };

export interface PageCommentView {
  id: string;
  pageId: string;
  parentId: string | null;
  authorKind: PageAuthorKind;
  authorRef: string | null;
  body: string;
  anchor: CommentAnchor;
  /** The page version the anchor points into (moved forward on every save). */
  version: number;
  /** The text the comment pointed at is gone from the current version. */
  detached: boolean;
  resolved: boolean;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProposalStatus = 'open' | 'accepted' | 'rejected';

export interface PageProposalView {
  id: string;
  spaceId: string;
  /** Null for a proposed new page. */
  pageId: string | null;
  baseVersion: number | null;
  title: string;
  content: string;
  summary: string | null;
  authorKind: 'agent';
  authorRef: string | null;
  status: ProposalStatus;
  /** The page moved on since the proposal was made; accepting needs `force`. */
  stale: boolean;
  createdAt: string;
  decidedAt: string | null;
}

const titleSchema = z.string().trim().min(1).max(200);
export const pageSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and hyphens (up to 63)');
const versionSchema = z.number().int().min(1);

export const createSpaceSchema = z
  .object({
    name: titleSchema,
    description: z.string().max(2000).nullable().optional(),
    projectId: z.string().min(1).max(100).nullable().optional(),
    agentEdits: z.enum(SPACE_AGENT_EDITS).optional(),
  })
  .strict();

export const updateSpaceSchema = z
  .object({
    name: titleSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
    agentEdits: z.enum(SPACE_AGENT_EDITS).optional(),
  })
  .strict();

export const createPageSchema = z
  .object({
    title: titleSchema,
    content: z.string().max(MAX_PAGE_CHARS).optional(),
    slug: pageSlugSchema.optional(),
  })
  .strict();

/** A save: a new version when the base is still the current one, else 409 with the newer page. */
export const savePageSchema = z
  .object({
    baseVersion: versionSchema,
    title: titleSchema.optional(),
    content: z.string().max(MAX_PAGE_CHARS).optional(),
    summary: z.string().max(500).optional(),
  })
  .strict()
  .refine((b) => b.title !== undefined || b.content !== undefined, {
    message: 'send a title or content',
  });

/** Metadata that is not versioned: the order of pages and the site file name. */
export const updatePageSchema = z
  .object({
    position: z.number().int().min(0).max(10_000).optional(),
    slug: pageSlugSchema.optional(),
  })
  .strict();

export const restorePageSchema = z
  .object({ version: versionSchema, baseVersion: versionSchema })
  .strict();

export const commentAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page') }).strict(),
  z
    .object({
      kind: z.literal('range'),
      start: z.number().int().min(0),
      end: z.number().int().min(0),
      quote: z.string().min(1).max(2000),
    })
    .strict()
    .refine((a) => a.end > a.start, { message: 'end must be after start' }),
  z
    .object({
      kind: z.literal('block'),
      index: z.number().int().min(0),
      quote: z.string().min(1).max(2000),
    })
    .strict(),
]);

export const createCommentSchema = z
  .object({
    body: z.string().trim().min(1).max(4000),
    anchor: commentAnchorSchema.optional(),
    /** The version the anchor was taken from (default: the current one). */
    version: versionSchema.optional(),
    parentId: z.string().min(1).max(100).optional(),
  })
  .strict();

export const resolveCommentSchema = z.object({ resolved: z.boolean() }).strict();

export const acceptProposalSchema = z.object({ force: z.boolean().optional() }).strict();

// ==== Sites (FR-037) =============================================================================

export type SiteSource =
  { kind: 'space'; spaceId: string } | { kind: 'artifact'; artifactId: string };

/** A JSON or CSV project source copied into the site as `data/<name>.json`. */
export interface SiteDataConnection {
  sourceId: string;
  name: string;
}

/**
 * M6 targets: a folder under the publish root, or a zip the user downloads. M8 adds a folder on a
 * remote hosting target the owner set up (`/api/v1/sites/targets`).
 */
export type SiteTarget =
  | { kind: 'folder'; folder: string }
  | { kind: 'zip' }
  | { kind: 'remote'; targetId: string; folder: string };

/** The remote hosting target a publish went to (M8), for showing it. */
export interface SiteRemoteRef {
  targetId: string;
  /** The target's name; null once it was removed. */
  name: string | null;
  /** Where the site's folder is on the target (the upload address). */
  location: string | null;
  /** Where visitors see it, when the target names a public address. */
  publicUrl: string | null;
}

export interface SiteView {
  id: string;
  name: string;
  description: string | null;
  source: SiteSource;
  /** The space's name or the artifact's title, when it still exists. */
  sourceLabel: string | null;
  data: SiteDataConnection[];
  latestVersion: number | null;
  publishedVersion: number | null;
  publishedTarget: SiteTarget | null;
  /** The live publish's remote target (M8), when it went to one. */
  publishedRemote?: SiteRemoteRef | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SiteFileView {
  path: string;
  size: number;
}

export interface SiteVersionView {
  siteId: string;
  version: number;
  note: string | null;
  files: SiteFileView[];
  size: number;
  sha256: string;
  /** Whether the preview may run the page's own scripts (an HTML artifact's), never same-origin. */
  scripts: boolean;
  published: boolean;
  createdAt: string;
}

export interface SitePublishView {
  id: string;
  siteId: string;
  version: number;
  target: SiteTarget;
  /** The remote target (M8), when it went to one. */
  remote?: SiteRemoteRef | null;
  /** The publish that is live now. */
  current: boolean;
  /** Undone by an unpublish. */
  revertedAt: string | null;
  createdAt: string;
}

export interface SitePublishResult {
  site: SiteView;
  publish: SitePublishView | null;
  /** For a zip target: where the client downloads the published version. */
  downloadUrl: string | null;
  /** For a folder target: the folder written on the Hub. */
  folderPath: string | null;
  /**
   * M8: where an earlier copy could not be taken down when the site moved to another target or
   * was unpublished (the target was unreachable); the user removes it there by hand.
   */
  leftBehind?: { target: SiteTarget; location: string | null; reason: string } | null;
}

/** A project source a site can connect as data (JSON or CSV). */
export interface SiteDataSourceView {
  id: string;
  name: string;
  mime: string;
  size: number;
  projectId: string;
  projectName: string;
}

export const siteDataName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'lowercase letters, digits, - and _ (up to 40)');

export const siteSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('space'), spaceId: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('artifact'), artifactId: z.string().min(1).max(100) }).strict(),
]);

export const siteDataSchema = z
  .array(z.object({ sourceId: z.string().min(1).max(100), name: siteDataName }).strict())
  .max(10)
  .refine((list) => new Set(list.map((d) => d.name)).size === list.length, {
    message: 'data names must be unique',
  });

export const siteTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('folder'), folder: pageSlugSchema }).strict(),
  z.object({ kind: z.literal('zip') }).strict(),
  z
    .object({
      kind: z.literal('remote'),
      targetId: z.string().min(1).max(100),
      folder: pageSlugSchema,
    })
    .strict(),
]);

export const createSiteSchema = z
  .object({
    name: titleSchema,
    description: z.string().max(2000).nullable().optional(),
    source: siteSourceSchema,
    data: siteDataSchema.optional(),
  })
  .strict();

export const updateSiteSchema = z
  .object({
    name: titleSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
    source: siteSourceSchema.optional(),
    data: siteDataSchema.optional(),
  })
  .strict();

export const buildSiteSchema = z.object({ note: z.string().max(500).optional() }).strict();

/** Publishing is explicit: the client must send `confirm: true` (FR-037). */
export const publishSiteSchema = z
  .object({ version: versionSchema, target: siteTargetSchema, confirm: z.literal(true) })
  .strict();

export const unpublishSiteSchema = z.object({ confirm: z.literal(true) }).strict();

// ==== M8: page order, deleted pages, a site's source, hosting targets (FR-036, FR-037) ===========

/** Set the order of a space's pages: every page it has now, each once. */
export const reorderPagesSchema = z
  .object({ pageIds: z.array(z.string().min(1).max(100)).min(1).max(10_000) })
  .strict()
  .refine((b) => new Set(b.pageIds).size === b.pageIds.length, { message: 'name each page once' });

/** What deleting a page takes with it, for the confirmation. Pages have no child pages. */
export interface PageDeletionView {
  pageId: string;
  spaceId: string;
  title: string;
  /** Saved versions (its history). */
  versions: number;
  /** Comment threads on it, open or resolved, and their replies. */
  comments: number;
  replies: number;
  /** Agent proposals for it that end rejected (they stay rejected after a restore). */
  openProposals: number;
  /** Sites built from the space: their next build leaves the page out. */
  sites: { id: string; name: string; publishedVersion: number | null }[];
}

/** A deleted page the space keeps, so it can be restored with its history and comments. */
export interface DeletedPageView {
  id: string;
  spaceId: string;
  title: string;
  slug: string;
  version: number;
  /** Comment threads and replies that come back with it. */
  comments: number;
  deletedAt: string;
}

/** Compare a build from another source (and data) with the site's latest version. */
export const siteSourcePreviewSchema = z
  .object({ source: siteSourceSchema.optional(), data: siteDataSchema.optional() })
  .strict();

export type SiteFileChange = 'added' | 'removed' | 'changed' | 'same';

export interface SiteSourcePreviewView {
  siteId: string;
  current: { source: SiteSource; sourceLabel: string | null; data: SiteDataConnection[] };
  next: { source: SiteSource; sourceLabel: string | null; data: SiteDataConnection[] };
  /** The latest built version the files are compared with; null when none was built. */
  comparedWith: number | null;
  /** The files a build from `next` makes, then the files only the compared version has. */
  files: (SiteFileView & { change: SiteFileChange })[];
  /** The total size of the files a build from `next` makes. */
  size: number;
  /** Whether that build's preview may run the source's own scripts. */
  scripts: boolean;
}

/** Hosting targets: where the owner publishes sites besides the Hub's folder and a zip. */
export const HOSTING_KINDS = ['webdav'] as const;
export type HostingKind = (typeof HOSTING_KINDS)[number];
export const HOSTING_AUTH = ['none', 'basic', 'bearer'] as const;
export type HostingAuth = (typeof HOSTING_AUTH)[number];

/** Why a check, publish or plan refused or failed (`details.reason`, `lastCheck.reason`). */
export type HostingProblem =
  | 'target_unreachable'
  | 'target_timeout'
  | 'target_auth_failed'
  | 'target_not_found'
  | 'target_refused'
  | 'target_redirected'
  | 'egress_denied'
  | 'remote_targets_off';

export interface SiteHostingTargetView {
  id: string;
  name: string;
  kind: HostingKind;
  /** The collection site folders go into (ends in `/`). */
  url: string;
  /** Where visitors see those folders, when it is another address (ends in `/`). */
  publicUrl: string | null;
  auth: HostingAuth;
  username: string | null;
  /** A password or token is in the vault (never returned). */
  hasCredential: boolean;
  /** Sites live on this target now. */
  sites: { siteId: string; name: string; folder: string; version: number }[];
  lastCheck: {
    ok: boolean;
    at: string;
    reason: HostingProblem | null;
    message: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

const hostingUrlSchema = z.string().trim().min(1).max(2000);
const hostingNameSchema = z.string().trim().min(1).max(100);

/** The credential a target sends; write-only, it goes to the vault. */
export const hostingCredentialSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('basic'),
      username: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[^:\p{Cc}]+$/u, 'no colon or control characters'),
      password: z.string().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('bearer'),
      token: z
        .string()
        .min(1)
        .max(4000)
        .regex(/^[\x21-\x7e]+$/, 'visible ASCII characters'),
    })
    .strict(),
]);

export const createHostingTargetSchema = z
  .object({
    name: hostingNameSchema,
    kind: z.enum(HOSTING_KINDS),
    url: hostingUrlSchema,
    publicUrl: hostingUrlSchema.nullable().optional(),
    credential: hostingCredentialSchema,
  })
  .strict();

/** A sent `credential` replaces the stored one; `url` cannot change while a site is live there. */
export const updateHostingTargetSchema = z
  .object({
    name: hostingNameSchema.optional(),
    url: hostingUrlSchema.optional(),
    publicUrl: hostingUrlSchema.nullable().optional(),
    credential: hostingCredentialSchema.optional(),
  })
  .strict();

/** What publishing a version to a target would do, shown before the user confirms it. */
export const publishPlanSchema = z
  .object({ version: versionSchema, target: siteTargetSchema })
  .strict();

export interface SitePublishPlanView {
  siteId: string;
  version: number;
  target: SiteTarget;
  remote: SiteRemoteRef | null;
  /** The folder on the Hub or the address on the remote target; null for a zip. */
  location: string | null;
  /** The files written or uploaded, and their total size. */
  files: SiteFileView[];
  size: number;
  /** What is live now and is replaced; null when nothing is published. */
  live: { version: number; target: SiteTarget; remote: SiteRemoteRef | null } | null;
  /** The live publish's place, when this publish moves the site away from it (taken down). */
  takesDown: { target: SiteTarget; remote: SiteRemoteRef | null } | null;
  /** Unpublishing takes it back; false for a zip download (the file cannot be recalled). */
  reversible: boolean;
  /** For a remote target: its host and whether the network policy lets Nova reach it. */
  egress: { host: string; allowed: boolean; message: string | null } | null;
}

// ==== Visualizations (FR-076): specs =============================================================

/** Series colors come from a fixed, ordered palette of this many slots; never cycled. */
export const VIZ_SERIES_SLOTS = 8;
/** Scatter plots validate only the first three slots against each other (all pairs). */
export const VIZ_SCATTER_SERIES = 3;

const vizText = z.string().trim().min(1).max(80);
const num = z.number().finite();

const categoricalSeries = z
  .array(z.object({ name: vizText, values: z.array(num.nullable()).max(200) }).strict())
  .min(1)
  .max(VIZ_SERIES_SLOTS);

/** Data from a connected site source: `x` names the label column, `y` the value columns. */
const bindSchema = z
  .object({
    source: siteDataName,
    x: z.string().min(1).max(80),
    y: z.array(z.string().min(1).max(80)).min(1).max(VIZ_SERIES_SLOTS),
  })
  .strict();

/** A caption for the chart where it is shown (a site page, a notebook cell). */
const chartTitle = z.string().trim().max(200).optional();

const axisSchema = z
  .object({ label: z.string().trim().max(80).optional(), min: num.optional(), max: num.optional() })
  .strict();

const barLine = (type: 'bar' | 'line') =>
  z
    .object({
      type: z.literal(type),
      title: chartTitle,
      labels: z.array(z.string().max(80)).min(1).max(200).optional(),
      series: categoricalSeries.optional(),
      data: bindSchema.optional(),
      stacked: z.boolean().optional(),
      x: axisSchema.optional(),
      y: axisSchema.optional(),
    })
    .strict()
    .superRefine((s, ctx) => {
      if (s.data) {
        if (s.labels || s.series)
          ctx.addIssue({ code: 'custom', message: 'use either data or labels and series' });
        return;
      }
      if (!s.labels || !s.series) {
        ctx.addIssue({ code: 'custom', message: 'labels and series are required' });
        return;
      }
      for (const [i, x] of s.series.entries())
        if (x.values.length !== s.labels.length)
          ctx.addIssue({
            code: 'custom',
            path: ['series', i, 'values'],
            message: `needs ${s.labels.length} values, one per label`,
          });
    });

export const chartSpecSchema = z.union([
  barLine('bar'),
  barLine('line'),
  z
    .object({
      type: z.literal('pie'),
      title: chartTitle,
      labels: z.array(z.string().max(80)).min(1).max(50),
      values: z.array(num.min(0)).min(1).max(50),
    })
    .strict()
    .refine((s) => s.labels.length === s.values.length, {
      message: 'pie needs one value per label',
    })
    .refine((s) => s.values.some((v) => v > 0), { message: 'pie needs a positive value' }),
  z
    .object({
      type: z.literal('scatter'),
      title: chartTitle,
      series: z
        .array(
          z
            .object({
              name: vizText,
              points: z
                .array(z.tuple([num, num]))
                .min(1)
                .max(2000),
            })
            .strict(),
        )
        .min(1)
        .max(VIZ_SCATTER_SERIES),
      x: axisSchema.optional(),
      y: axisSchema.optional(),
    })
    .strict(),
]);
export type ChartSpec = z.infer<typeof chartSpecSchema>;

const nodeId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'letters, digits, _ and - (up to 40)');

export const flowchartSpecSchema = z
  .object({
    type: z.literal('flowchart'),
    direction: z.enum(['down', 'right']).optional(),
    nodes: z
      .array(
        z
          .object({
            id: nodeId,
            label: vizText,
            shape: z.enum(['box', 'round', 'diamond']).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(60),
    edges: z
      .array(
        z
          .object({ from: nodeId, to: nodeId, label: z.string().trim().max(40).optional() })
          .strict(),
      )
      .max(120),
  })
  .strict()
  .superRefine((s, ctx) => {
    const ids = new Set<string>();
    for (const n of s.nodes) {
      if (ids.has(n.id)) ctx.addIssue({ code: 'custom', message: `node ${n.id} appears twice` });
      ids.add(n.id);
    }
    for (const e of s.edges)
      if (!ids.has(e.from) || !ids.has(e.to))
        ctx.addIssue({
          code: 'custom',
          message: `edge ${e.from} -> ${e.to} names an unknown node`,
        });
  });

export const sequenceSpecSchema = z
  .object({
    type: z.literal('sequence'),
    participants: z
      .array(z.object({ id: nodeId, label: vizText }).strict())
      .min(1)
      .max(12),
    messages: z
      .array(
        z
          .object({
            from: nodeId,
            to: nodeId,
            label: z.string().trim().max(80),
            reply: z.boolean().optional(),
          })
          .strict(),
      )
      .max(80),
  })
  .strict()
  .superRefine((s, ctx) => {
    const ids = new Set(s.participants.map((p) => p.id));
    if (ids.size !== s.participants.length)
      ctx.addIssue({ code: 'custom', message: 'participant ids must be unique' });
    for (const m of s.messages)
      if (!ids.has(m.from) || !ids.has(m.to))
        ctx.addIssue({
          code: 'custom',
          message: `message ${m.from} -> ${m.to} names an unknown participant`,
        });
  });

export const diagramSpecSchema = z.union([flowchartSpecSchema, sequenceSpecSchema]);
export type DiagramSpec = z.infer<typeof diagramSpecSchema>;
export type FlowchartSpec = z.infer<typeof flowchartSpecSchema>;
export type SequenceSpec = z.infer<typeof sequenceSpecSchema>;

export const notebookSpecSchema = z
  .object({
    cells: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('markdown'), text: z.string().max(20_000) }).strict(),
          z.object({ type: z.literal('chart'), spec: chartSpecSchema }).strict(),
          z.object({ type: z.literal('diagram'), spec: diagramSpecSchema }).strict(),
        ]),
      )
      .min(1)
      .max(40),
  })
  .strict();
export type NotebookSpec = z.infer<typeof notebookSpecSchema>;

export const VIZ_KINDS = ['chart', 'diagram', 'notebook'] as const;
export type VizKind = (typeof VIZ_KINDS)[number];

/** The JSON a visualization artifact (kind `chart`) holds (FR-076). */
export type VisualizationDoc =
  | { type: 'nova.visualization'; version: 1; kind: 'chart'; title: string | null; spec: ChartSpec }
  | {
      type: 'nova.visualization';
      version: 1;
      kind: 'diagram';
      title: string | null;
      spec: DiagramSpec;
    }
  | {
      type: 'nova.visualization';
      version: 1;
      kind: 'notebook';
      title: string | null;
      spec: NotebookSpec;
    };

export const visualizationDocSchema = z.discriminatedUnion('kind', [
  z
    .object({
      type: z.literal('nova.visualization'),
      version: z.literal(1),
      kind: z.literal('chart'),
      title: z.string().max(200).nullable(),
      spec: chartSpecSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('nova.visualization'),
      version: z.literal(1),
      kind: z.literal('diagram'),
      title: z.string().max(200).nullable(),
      spec: diagramSpecSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('nova.visualization'),
      version: z.literal(1),
      kind: z.literal('notebook'),
      title: z.string().max(200).nullable(),
      spec: notebookSpecSchema,
    })
    .strict(),
]);

/** Parse an artifact's text as a visualization document; null when it is not one. */
export function parseVisualizationDoc(text: string): VisualizationDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = visualizationDocSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Zod issues as one short sentence for a tool result or an error message. */
export function vizIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

// ---- diagram text (a small flowchart and sequence subset) --------------------------------------

/**
 * Parse the text form of a diagram:
 *
 *     flowchart right            sequence
 *     a[Start] --> b{Ready?}     participant u as User
 *     b -->|yes| c(Ship)         u ->> h: request
 *     b -- no --> a              h -->> u: reply
 *
 * Throws an Error naming the line on anything it does not understand.
 */
export function parseDiagramText(text: string): DiagramSpec {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/%%.*$/, '').trim())
    .filter(Boolean);
  const head = (lines.shift() ?? '').toLowerCase().split(/\s+/);
  if (head[0] === 'flowchart' || head[0] === 'graph') return parseFlowchart(head[1], lines);
  if (head[0] === 'sequence' || head[0] === 'sequencediagram') return parseSequence(lines);
  throw new Error('a diagram starts with "flowchart" or "sequence"');
}

// id, id[box], id(round), id((round)), id{diamond}
const NODE_RE =
  /^([A-Za-z0-9_-]{1,40})\s*(?:\[([^\]]*)\]|\(\(([^)]*)\)\)|\(([^)]*)\)|\{([^}]*)\})?/;

function parseFlowchart(dir: string | undefined, lines: string[]): FlowchartSpec {
  const direction = dir === 'right' || dir === 'lr' ? 'right' : 'down';
  const nodes = new Map<string, FlowchartSpec['nodes'][number]>();
  const edges: FlowchartSpec['edges'] = [];
  const node = (src: string, lineNo: number): { id: string; rest: string } => {
    const m = NODE_RE.exec(src);
    if (!m?.[1]) throw new Error(`line ${lineNo}: expected a node id`);
    const id = m[1];
    const label = m[2] ?? m[3] ?? m[4] ?? m[5];
    const shape =
      m[2] !== undefined
        ? 'box'
        : m[3] !== undefined || m[4] !== undefined
          ? 'round'
          : m[5] !== undefined
            ? 'diamond'
            : null;
    const prev = nodes.get(id);
    if (!prev || label !== undefined)
      nodes.set(id, {
        id,
        label: (label ?? prev?.label ?? id).trim().slice(0, 80) || id,
        shape: shape ?? prev?.shape ?? 'box',
      });
    return { id, rest: src.slice(m[0].length).trim() };
  };
  lines.forEach((line, i) => {
    const lineNo = i + 2;
    let { id: from, rest } = node(line, lineNo);
    while (rest) {
      // --> , ---, -->|label|, -- label -->
      const arrow = /^(?:--\s*([^-|>][^>]*?)\s*-->|-->\s*\|([^|]*)\||-->|---)\s*/.exec(rest);
      if (!arrow) throw new Error(`line ${lineNo}: expected --> after ${from}`);
      const label = (arrow[1] ?? arrow[2] ?? '').trim();
      const next = node(rest.slice(arrow[0].length), lineNo);
      edges.push({ from, to: next.id, ...(label ? { label: label.slice(0, 40) } : {}) });
      from = next.id;
      rest = next.rest;
    }
  });
  return flowchartSpecSchema.parse({
    type: 'flowchart',
    direction,
    nodes: [...nodes.values()],
    edges,
  });
}

function parseSequence(lines: string[]): SequenceSpec {
  const participants = new Map<string, string>();
  const messages: SequenceSpec['messages'] = [];
  const see = (id: string) => {
    if (!participants.has(id)) participants.set(id, id);
  };
  lines.forEach((line, i) => {
    const lineNo = i + 2;
    const p = /^(?:participant|actor)\s+([A-Za-z0-9_-]{1,40})(?:\s+as\s+(.+))?$/i.exec(line);
    if (p?.[1]) {
      participants.set(p[1], (p[2] ?? p[1]).trim().slice(0, 80));
      return;
    }
    const m = /^([A-Za-z0-9_-]{1,40})\s*(--?>>?)\s*([A-Za-z0-9_-]{1,40})\s*:\s*(.*)$/.exec(line);
    if (!m?.[1] || !m[3] || !m[2]) throw new Error(`line ${lineNo}: expected "a ->> b: message"`);
    see(m[1]);
    see(m[3]);
    messages.push({
      from: m[1],
      to: m[3],
      label: (m[4] ?? '').trim().slice(0, 80),
      ...(m[2].startsWith('--') ? { reply: true } : {}),
    });
  });
  return sequenceSpecSchema.parse({
    type: 'sequence',
    participants: [...participants].map(([id, label]) => ({ id, label })),
    messages,
  });
}

// ---- data binding ---------------------------------------------------------------------------------

/** Rows of a connected data source (objects keyed by column). */
export type VizRows = readonly Record<string, unknown>[];

function cellText(v: unknown): string {
  return typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : '';
}

/**
 * Resolve a bar or line chart's `data` binding against the site's data rows. Throws an Error when
 * the source or a column is missing; other charts pass through.
 */
export function bindChartData(
  spec: ChartSpec,
  sources: Readonly<Record<string, VizRows>>,
): ChartSpec {
  if ((spec.type !== 'bar' && spec.type !== 'line') || !spec.data) return spec;
  const rows = sources[spec.data.source];
  if (!rows) throw new Error(`no connected data named ${spec.data.source}`);
  const take = rows.slice(0, 200);
  const { x, y } = spec.data;
  const toNum = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
    return null;
  };
  const { data: _data, ...rest } = spec;
  return {
    ...rest,
    labels: take.map((r) => cellText(r[x]).slice(0, 80)),
    series: y.map((col) => ({ name: col.slice(0, 80), values: take.map((r) => toNum(r[col])) })),
  };
}

// ==== Visualizations: the scene ===================================================================

/**
 * Class names a scene uses; renderers style them (series slot `s0`..`s7` in a fixed order).
 * `mark` fills with the series color, `line` strokes with it, `dot` fills it with a surface ring.
 */
export type VizClass = string;

export type VizItem =
  | { t: 'rect'; x: number; y: number; w: number; h: number; cls: VizClass; rx?: number }
  | { t: 'path'; d: string; cls: VizClass }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; cls: VizClass }
  | { t: 'circle'; cx: number; cy: number; r: number; cls: VizClass }
  | {
      t: 'text';
      x: number;
      y: number;
      text: string;
      cls: VizClass;
      anchor: 'start' | 'middle' | 'end';
    };

/** A hover and focus target with the readout it shows (values lead, names follow). */
export interface VizTarget {
  /** A rectangle, or a path for pie slices. */
  x: number;
  y: number;
  w: number;
  h: number;
  d?: string;
  label: string;
  rows: { series: number | null; name: string; value: string }[];
}

export interface VizTable {
  columns: string[];
  rows: string[][];
}

export interface VizScene {
  width: number;
  height: number;
  /** A one-line description for assistive technology. */
  summary: string;
  items: VizItem[];
  targets: VizTarget[];
  /** The same numbers as a table (FR-076: nothing is reachable only by hovering). */
  table: VizTable | null;
}

const CHAR_W = 6.8;
const FONT = 12;

/** Width of a label at the scene's font size (an estimate; no fonts are measured). */
export function textWidth(s: string): number {
  return Math.ceil(s.length * CHAR_W);
}

function clip(s: string, maxW: number): string {
  if (textWidth(s) <= maxW) return s;
  const n = Math.max(1, Math.floor(maxW / CHAR_W) - 1);
  return `${s.slice(0, n)}…`;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** 1,284 -> 1.3K; 12,900,000 -> 12.9M (axis ticks). */
export function formatCompact(n: number): string {
  const a = Math.abs(n);
  const fix = (v: number) => {
    const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
    return String(Number(v.toFixed(digits)));
  };
  if (a >= 1e12) return `${fix(n / 1e12)}T`;
  if (a >= 1e9) return `${fix(n / 1e9)}B`;
  if (a >= 1e6) return `${fix(n / 1e6)}M`;
  if (a >= 1e3) return `${fix(n / 1e3)}K`;
  return fix(n);
}

const VALUE_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
/** A full value for readouts and tables. */
export function formatValue(n: number): string {
  return VALUE_FORMAT.format(n);
}

/** Round ticks covering [min, max], always including both ends of the data. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  let lo = min;
  let hi = max;
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else if (lo > 0) lo = 0;
    else hi = 0;
  }
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = start, i = 0; v <= end + step / 2 && i < 50; v += step, i++)
    out.push(Number(v.toPrecision(12)));
  return out;
}

interface Frame {
  items: VizItem[];
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Legend entries in one or more rows across the top; returns the height used. */
function legend(
  items: VizItem[],
  entries: { name: string; series: number }[],
  width: number,
  swatch: 'rect' | 'line' | 'dot',
): number {
  if (entries.length < 2) return 0;
  let x = 0;
  let y = 10;
  for (const e of entries) {
    const label = clip(e.name, 160);
    const w = 18 + textWidth(label) + 16;
    if (x > 0 && x + w > width) {
      x = 0;
      y += 20;
    }
    const cls = `s${e.series}`;
    if (swatch === 'line')
      items.push({ t: 'line', x1: x, y1: y, x2: x + 12, y2: y, cls: `line key ${cls}` });
    else if (swatch === 'dot')
      items.push({ t: 'circle', cx: x + 6, cy: y, r: 4, cls: `dot ${cls}` });
    else items.push({ t: 'rect', x, y: y - 5, w: 12, h: 10, rx: 2, cls: `mark ${cls}` });
    items.push({ t: 'text', x: x + 18, y: y + 4, text: label, cls: 'legend', anchor: 'start' });
    x += w;
  }
  return y + 16;
}

function yAxis(
  f: Frame,
  ticks: number[],
  scale: (v: number) => number,
  label: string | undefined,
): void {
  for (const t of ticks) {
    const y = round(scale(t));
    f.items.push({
      t: 'line',
      x1: f.left,
      y1: y,
      x2: f.right,
      y2: y,
      cls: t === 0 ? 'axis' : 'grid',
    });
    f.items.push({
      t: 'text',
      x: f.left - 8,
      y: y + 4,
      text: formatCompact(t),
      cls: 'tick',
      anchor: 'end',
    });
  }
  if (label)
    f.items.push({
      t: 'text',
      x: 0,
      y: f.top - 10,
      text: clip(label, 200),
      cls: 'axis-label',
      anchor: 'start',
    });
}

/** Rounded data end, square at the baseline (bars grow from one baseline). */
function barPath(x: number, w: number, y0: number, y1: number): string {
  const up = y1 < y0;
  const h = Math.abs(y1 - y0);
  const r = Math.min(4, w / 2, h);
  const a = round(x);
  const b = round(x + w);
  const base = round(y0);
  const tip = round(y1);
  if (r <= 0.5) return `M${a},${base}V${tip}H${b}V${base}Z`;
  if (up)
    return `M${a},${base}V${round(tip + r)}Q${a},${tip} ${round(a + r)},${tip}H${round(b - r)}Q${b},${tip} ${b},${round(tip + r)}V${base}Z`;
  return `M${a},${base}V${round(tip - r)}Q${a},${tip} ${round(a + r)},${tip}H${round(b - r)}Q${b},${tip} ${b},${round(tip - r)}V${base}Z`;
}

export interface VizLayoutOptions {
  width?: number;
  height?: number;
}

/** Lay out a chart (bar, line, pie, scatter). Bound data must be resolved first. */
export function layoutChart(spec: ChartSpec, opts: VizLayoutOptions = {}): VizScene {
  const width = opts.width ?? 640;
  const height = opts.height ?? 360;
  switch (spec.type) {
    case 'bar':
    case 'line':
      return layoutCategorical(spec, width, height);
    case 'pie':
      return layoutPie(spec, width, height);
    case 'scatter':
      return layoutScatter(spec, width, height);
  }
}

type BarLine = Extract<ChartSpec, { type: 'bar' | 'line' }>;

function layoutCategorical(spec: BarLine, width: number, height: number): VizScene {
  const labels = spec.labels ?? [];
  const series = spec.series ?? [];
  const items: VizItem[] = [];
  const targets: VizTarget[] = [];
  const legendH = legend(
    items,
    series.map((s, i) => ({ name: s.name, series: i })),
    width,
    spec.type === 'bar' ? 'rect' : 'line',
  );
  const stacked = spec.type === 'bar' && spec.stacked === true && series.length > 1;
  // The value range: stacked bars sum positives and negatives separately.
  let lo = 0;
  let hi = 0;
  labels.forEach((_, i) => {
    let pos = 0;
    let neg = 0;
    for (const s of series) {
      const v = s.values[i];
      if (v === null || v === undefined) continue;
      if (stacked) {
        if (v >= 0) pos += v;
        else neg += v;
      } else {
        hi = Math.max(hi, v);
        lo = Math.min(lo, v);
      }
    }
    if (stacked) {
      hi = Math.max(hi, pos);
      lo = Math.min(lo, neg);
    }
  });
  if (spec.type === 'line') {
    // A line chart need not start at zero when every value is far from it.
    const vals = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
    if (vals.length) {
      const mn = Math.min(...vals);
      const mx = Math.max(...vals);
      lo = mn > 0 && mn > (mx - mn) * 2 ? mn : Math.min(0, mn);
      hi = mx < 0 && -mx > (mx - mn) * 2 ? mx : Math.max(0, mx);
    }
  }
  if (spec.y?.min !== undefined) lo = Math.min(lo, spec.y.min);
  if (spec.y?.max !== undefined) hi = Math.max(hi, spec.y.max);
  const ticks = niceTicks(lo, hi);
  const tMin = ticks[0] ?? 0;
  const tMax = ticks.at(-1) ?? 1;
  const tickW = Math.max(...ticks.map((t) => textWidth(formatCompact(t))));
  const yLabelH = spec.y?.label ? 18 : 0;
  const f: Frame = {
    items,
    left: tickW + 14,
    top: legendH + yLabelH + 10,
    right: width - 12,
    bottom: height - (spec.x?.label ? 44 : 26),
  };
  const scaleY = (v: number) => f.bottom - ((v - tMin) / (tMax - tMin || 1)) * (f.bottom - f.top);
  yAxis(f, ticks, scaleY, spec.y?.label);
  const n = Math.max(1, labels.length);
  const band = (f.right - f.left) / n;
  // Category labels: thinned so they never overlap, clipped to the space they get.
  const longest = Math.max(...labels.map((l) => textWidth(l)), 1);
  const every = Math.max(1, Math.ceil((Math.min(longest, 120) + 8) / band));
  labels.forEach((l, i) => {
    if (i % every !== 0) return;
    const cx = f.left + band * (i + 0.5);
    items.push({
      t: 'text',
      x: round(cx),
      y: f.bottom + 16,
      text: clip(l, Math.max(band * every - 6, 24)),
      cls: 'tick',
      anchor: 'middle',
    });
  });
  if (spec.x?.label)
    items.push({
      t: 'text',
      x: round((f.left + f.right) / 2),
      y: height - 8,
      text: clip(spec.x.label, width - 40),
      cls: 'axis-label',
      anchor: 'middle',
    });
  const zero = scaleY(Math.max(tMin, Math.min(0, tMax)));
  const readout = (i: number) =>
    series.map((s, si) => {
      const v = s.values[i];
      return {
        series: si,
        name: s.name,
        value: v === null || v === undefined ? '–' : formatValue(v),
      };
    });
  if (spec.type === 'bar') {
    const groups = stacked ? 1 : series.length;
    const barW = Math.max(2, Math.min(24, (band * 0.72 - (groups - 1) * 2) / groups));
    const groupW = groups * barW + (groups - 1) * 2;
    labels.forEach((label, i) => {
      const x0 = f.left + band * i + (band - groupW) / 2;
      let pos = zero;
      let neg = zero;
      series.forEach((s, si) => {
        const v = s.values[i];
        if (v === null || v === undefined || v === 0) return;
        const x = stacked ? x0 : x0 + si * (barW + 2);
        let y0: number;
        let y1: number;
        if (stacked) {
          // A 2px surface gap separates stacked segments.
          y0 = v > 0 ? pos : neg;
          y1 = y0 + (scaleY(v) - zero);
          if (v > 0) pos = y1 - 2;
          else neg = y1 + 2;
        } else {
          y0 = zero;
          y1 = scaleY(v);
        }
        items.push({ t: 'path', d: barPath(x, barW, y0, y1), cls: `mark s${si}` });
      });
      targets.push({
        x: round(f.left + band * i),
        y: f.top,
        w: round(band),
        h: round(f.bottom - f.top),
        label,
        rows: readout(i),
      });
    });
  } else {
    series.forEach((s, si) => {
      let d = '';
      let pen = false;
      let last: { x: number; y: number; v: number } | null = null;
      s.values.forEach((v, i) => {
        if (v === null) {
          pen = false;
          return;
        }
        const x = round(f.left + band * (i + 0.5));
        const y = round(scaleY(v));
        d += `${pen ? 'L' : 'M'}${x},${y}`;
        pen = true;
        last = { x, y, v };
      });
      if (d) items.push({ t: 'path', d, cls: `line s${si}` });
      const end = last as { x: number; y: number; v: number } | null;
      if (end) items.push({ t: 'circle', cx: end.x, cy: end.y, r: 4, cls: `dot s${si}` });
    });
    // Direct end labels for up to four series, dropped when they would collide.
    if (series.length <= 4) {
      const ends = series
        .map((s, si) => {
          const idx = s.values.findLastIndex((v) => v !== null);
          const v = idx >= 0 ? s.values[idx] : null;
          return v === null || v === undefined
            ? null
            : { si, x: f.left + band * (idx + 0.5), y: scaleY(v), v };
        })
        .filter((e): e is { si: number; x: number; y: number; v: number } => e !== null);
      const collide = ends.some((a, i) => ends.some((b, j) => i < j && Math.abs(a.y - b.y) < 14));
      if (!collide)
        for (const e of ends)
          items.push({
            t: 'text',
            x: round(Math.min(e.x, f.right - 4)),
            y: round(e.y - 9),
            text: formatCompact(e.v),
            cls: 'value',
            anchor: 'end',
          });
    }
    labels.forEach((label, i) =>
      targets.push({
        x: round(f.left + band * i),
        y: f.top,
        w: round(band),
        h: round(f.bottom - f.top),
        label,
        rows: readout(i),
      }),
    );
  }
  return {
    width,
    height,
    summary: `${spec.type === 'bar' ? (stacked ? 'Stacked bar' : 'Bar') : 'Line'} chart of ${series
      .map((s) => s.name)
      .join(', ')} over ${labels.length} ${labels.length === 1 ? 'category' : 'categories'}`,
    items,
    targets,
    table: {
      columns: [spec.x?.label ?? '', ...series.map((s) => s.name)],
      rows: labels.map((l, i) => [
        l,
        ...series.map((s) => {
          const v = s.values[i];
          return v === null || v === undefined ? '' : formatValue(v);
        }),
      ]),
    },
  };
}

type Pie = Extract<ChartSpec, { type: 'pie' }>;

/** Slices past the seventh fold into "Other" so no color is ever cycled. */
export function foldPie(spec: Pie): { labels: string[]; values: number[] } {
  const pairs = spec.labels.map((l, i) => ({ l, v: spec.values[i] ?? 0 })).filter((p) => p.v > 0);
  if (pairs.length <= VIZ_SERIES_SLOTS)
    return { labels: pairs.map((p) => p.l), values: pairs.map((p) => p.v) };
  const keep = [...pairs].sort((a, b) => b.v - a.v).slice(0, VIZ_SERIES_SLOTS - 1);
  const kept = pairs.filter((p) => keep.includes(p));
  const other = pairs.filter((p) => !keep.includes(p)).reduce((a, p) => a + p.v, 0);
  return { labels: [...kept.map((p) => p.l), 'Other'], values: [...kept.map((p) => p.v), other] };
}

function layoutPie(spec: Pie, width: number, height: number): VizScene {
  const { labels, values } = foldPie(spec);
  const items: VizItem[] = [];
  const targets: VizTarget[] = [];
  const legendH = legend(
    items,
    labels.map((name, i) => ({ name, series: i })),
    width,
    'rect',
  );
  const total = values.reduce((a, v) => a + v, 0);
  const cy = legendH + (height - legendH) / 2;
  const cx = width / 2;
  const r = Math.max(20, Math.min(width, height - legendH) / 2 - 16);
  let a0 = -Math.PI / 2;
  const pct = (v: number) => `${formatValue(Math.round((v / total) * 1000) / 10)}%`;
  values.forEach((v, i) => {
    const a1 = a0 + (v / total) * Math.PI * 2;
    let d: string;
    if (values.length === 1) {
      d = `M${round(cx - r)},${round(cy)}A${round(r)},${round(r)} 0 1 1 ${round(cx + r)},${round(cy)}A${round(r)},${round(r)} 0 1 1 ${round(cx - r)},${round(cy)}Z`;
    } else {
      const large = a1 - a0 > Math.PI ? 1 : 0;
      d = `M${round(cx)},${round(cy)}L${round(cx + r * Math.cos(a0))},${round(cy + r * Math.sin(a0))}A${round(r)},${round(r)} 0 ${large} 1 ${round(cx + r * Math.cos(a1))},${round(cy + r * Math.sin(a1))}Z`;
    }
    items.push({ t: 'path', d, cls: `mark gap s${i}` });
    const label = labels[i] ?? '';
    targets.push({
      x: round(cx - r),
      y: round(cy - r),
      w: round(r * 2),
      h: round(r * 2),
      d,
      label,
      rows: [{ series: i, name: label, value: `${formatValue(v)} (${pct(v)})` }],
    });
    // A percentage label inside a slice only when the slice is wide enough to hold it.
    if (a1 - a0 > 0.45) {
      const mid = (a0 + a1) / 2;
      items.push({
        t: 'text',
        x: round(cx + r * 0.62 * Math.cos(mid)),
        y: round(cy + r * 0.62 * Math.sin(mid) + 4),
        text: pct(v),
        cls: 'on-mark',
        anchor: 'middle',
      });
    }
    a0 = a1;
  });
  return {
    width,
    height,
    summary: `Pie chart of ${labels.length} parts totalling ${formatValue(total)}`,
    items,
    targets,
    table: {
      columns: ['', 'Value', 'Share'],
      rows: labels.map((l, i) => [l, formatValue(values[i] ?? 0), pct(values[i] ?? 0)]),
    },
  };
}

type Scatter = Extract<ChartSpec, { type: 'scatter' }>;

function layoutScatter(spec: Scatter, width: number, height: number): VizScene {
  const items: VizItem[] = [];
  const targets: VizTarget[] = [];
  const legendH = legend(
    items,
    spec.series.map((s, i) => ({ name: s.name, series: i })),
    width,
    'dot',
  );
  const xs = spec.series.flatMap((s) => s.points.map((p) => p[0]));
  const ys = spec.series.flatMap((s) => s.points.map((p) => p[1]));
  // A little room around the points, so none sits on the frame.
  const padded = (vals: number[], lo?: number, hi?: number): number[] => {
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const pad = mx > mn ? (mx - mn) * 0.05 : 0.5;
    return niceTicks(lo ?? mn - pad, hi ?? mx + pad);
  };
  const xt = padded(xs, spec.x?.min, spec.x?.max);
  const yt = padded(ys, spec.y?.min, spec.y?.max);
  const tickW = Math.max(...yt.map((t) => textWidth(formatCompact(t))));
  const f: Frame = {
    items,
    left: tickW + 14,
    top: legendH + (spec.y?.label ? 18 : 0) + 10,
    right: width - 16,
    bottom: height - (spec.x?.label ? 44 : 26),
  };
  const x0 = xt[0] ?? 0;
  const x1 = xt.at(-1) ?? 1;
  const y0 = yt[0] ?? 0;
  const y1 = yt.at(-1) ?? 1;
  const sx = (v: number) => f.left + ((v - x0) / (x1 - x0 || 1)) * (f.right - f.left);
  const sy = (v: number) => f.bottom - ((v - y0) / (y1 - y0 || 1)) * (f.bottom - f.top);
  yAxis(f, yt, sy, spec.y?.label);
  for (const t of xt) {
    const x = round(sx(t));
    items.push({ t: 'line', x1: x, y1: f.top, x2: x, y2: f.bottom, cls: 'grid' });
    items.push({
      t: 'text',
      x,
      y: f.bottom + 16,
      text: formatCompact(t),
      cls: 'tick',
      anchor: 'middle',
    });
  }
  if (spec.x?.label)
    items.push({
      t: 'text',
      x: round((f.left + f.right) / 2),
      y: height - 8,
      text: clip(spec.x.label, width - 40),
      cls: 'axis-label',
      anchor: 'middle',
    });
  const xName = spec.x?.label ?? 'x';
  const yName = spec.y?.label ?? 'y';
  spec.series.forEach((s, si) => {
    for (const [px, py] of s.points) {
      const cx = round(sx(px));
      const cy = round(sy(py));
      items.push({ t: 'circle', cx, cy, r: 4, cls: `dot s${si}` });
      // The hit target is larger than the mark (24px).
      targets.push({
        x: cx - 12,
        y: cy - 12,
        w: 24,
        h: 24,
        label: s.name,
        rows: [
          { series: si, name: xName, value: formatValue(px) },
          { series: si, name: yName, value: formatValue(py) },
        ],
      });
    }
  });
  const total = spec.series.reduce((a, s) => a + s.points.length, 0);
  return {
    width,
    height,
    summary: `Scatter plot of ${total} points in ${spec.series.length} ${spec.series.length === 1 ? 'series' : 'series'}`,
    items,
    targets: total <= 500 ? targets : [],
    table: {
      columns: ['Series', xName, yName],
      rows: spec.series.flatMap((s) =>
        s.points.map((p) => [s.name, formatValue(p[0]), formatValue(p[1])]),
      ),
    },
  };
}

// ---- diagrams --------------------------------------------------------------------------------------

/** Lay out a flowchart or a sequence diagram. */
export function layoutDiagram(spec: DiagramSpec): VizScene {
  return spec.type === 'flowchart' ? layoutFlowchart(spec) : layoutSequence(spec);
}

function arrowHead(x: number, y: number, angle: number): string {
  const s = 7;
  const a1 = angle + Math.PI - 0.45;
  const a2 = angle + Math.PI + 0.45;
  return `M${round(x)},${round(y)}L${round(x + s * Math.cos(a1))},${round(y + s * Math.sin(a1))}L${round(x + s * Math.cos(a2))},${round(y + s * Math.sin(a2))}Z`;
}

/** Where the segment from a node's center toward (tx, ty) leaves its box. */
function boxExit(
  b: { x: number; y: number; w: number; h: number },
  tx: number,
  ty: number,
): { x: number; y: number } {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx === 0 ? Infinity : b.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : b.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

function layoutFlowchart(spec: FlowchartSpec): VizScene {
  const down = (spec.direction ?? 'down') === 'down';
  // Layers by longest path from the sources; edges that close a cycle are ignored for layering.
  const out = new Map<string, string[]>();
  for (const n of spec.nodes) out.set(n.id, []);
  for (const e of spec.edges) out.get(e.from)?.push(e.to);
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const to of out.get(id) ?? []) {
      if (state.get(to) === 1) back.add(`${id}\u0000${to}`);
      else if (!state.has(to)) visit(to);
    }
    state.set(id, 2);
  };
  for (const n of spec.nodes) if (!state.has(n.id)) visit(n.id);
  const layer = new Map<string, number>(spec.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < spec.nodes.length; pass++) {
    let changed = false;
    for (const e of spec.edges) {
      if (back.has(`${e.from}\u0000${e.to}`) || e.from === e.to) continue;
      const want = (layer.get(e.from) ?? 0) + 1;
      if ((layer.get(e.to) ?? 0) < want) {
        layer.set(e.to, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const layers: string[][] = [];
  for (const n of spec.nodes) (layers[layer.get(n.id) ?? 0] ??= []).push(n.id);
  // One ordering pass: each node sits near the mean position of its parents.
  const pos = new Map<string, number>();
  layers.forEach((ids, li) => {
    if (li > 0)
      ids.sort((a, b) => {
        const mean = (id: string) => {
          const ps = spec.edges
            .filter((e) => e.to === id && pos.has(e.from))
            .map((e) => pos.get(e.from)!);
          return ps.length ? ps.reduce((x, y) => x + y, 0) / ps.length : Infinity;
        };
        return mean(a) - mean(b);
      });
    ids.forEach((id, i) => pos.set(id, i));
  });
  const size = new Map(
    spec.nodes.map((n) => {
      const w = Math.max(72, Math.min(220, textWidth(n.label) + 28));
      return [n.id, { w, h: n.shape === 'diamond' ? 52 : 36 }];
    }),
  );
  const gapMain = 56;
  const gapCross = 28;
  const box = new Map<string, { x: number; y: number; w: number; h: number }>();
  let main = 16;
  let crossMax = 0;
  const crossSizes = layers.map((ids) =>
    ids.reduce((a, id) => a + (down ? size.get(id)!.w : size.get(id)!.h) + gapCross, -gapCross),
  );
  const crossTotal = Math.max(...crossSizes, 0);
  layers.forEach((ids, li) => {
    const thick = Math.max(...ids.map((id) => (down ? size.get(id)!.h : size.get(id)!.w)));
    let cross = 16 + (crossTotal - (crossSizes[li] ?? 0)) / 2;
    for (const id of ids) {
      const s = size.get(id)!;
      const b = down
        ? { x: cross, y: main + (thick - s.h) / 2, w: s.w, h: s.h }
        : { x: main + (thick - s.w) / 2, y: cross, w: s.w, h: s.h };
      box.set(id, b);
      cross += (down ? s.w : s.h) + gapCross;
    }
    crossMax = Math.max(crossMax, cross);
    main += thick + gapMain;
  });
  let width = Math.ceil(down ? crossTotal + 32 : main - gapMain + 16);
  let height = Math.ceil(down ? main - gapMain + 16 : crossTotal + 32);
  const items: VizItem[] = [];
  const targets: VizTarget[] = [];
  const label = new Map(spec.nodes.map((n) => [n.id, n.label]));
  const edgeLabel = (x: number, y: number, text: string) => {
    const w = textWidth(text) + 8;
    items.push({
      t: 'rect',
      x: round(x - w / 2),
      y: round(y - 9),
      w,
      h: 18,
      rx: 4,
      cls: 'edge-label-bg',
    });
    items.push({
      t: 'text',
      x: round(x),
      y: round(y + 4),
      text,
      cls: 'edge-label',
      anchor: 'middle',
    });
  };
  // The far side of the drawing: edges that skip layers or go back bend around it, one lane each.
  let lane = 0;
  const far = crossTotal + 16;
  for (const e of spec.edges) {
    const a = box.get(e.from);
    const b = box.get(e.to);
    if (!a || !b) continue;
    if (e.from === e.to) {
      // A self loop on the node's far side.
      const x = a.x + a.w;
      const y = a.y + a.h / 2;
      items.push({
        t: 'path',
        d: `M${round(x)},${round(y - 8)}C${round(x + 30)},${round(y - 24)} ${round(x + 30)},${round(y + 24)} ${round(x)},${round(y + 8)}`,
        cls: 'edge',
      });
      items.push({ t: 'path', d: arrowHead(x, y + 8, Math.PI), cls: 'arrow' });
      if (e.label) edgeLabel(x + 34 + textWidth(e.label) / 2, y, e.label);
      width = Math.max(width, Math.ceil(x + 40 + (e.label ? textWidth(e.label) + 8 : 0)));
      continue;
    }
    const span = (layer.get(e.to) ?? 0) - (layer.get(e.from) ?? 0);
    if (span === 1 || span === 0) {
      const p = boxExit(a, b.x + b.w / 2, b.y + b.h / 2);
      const q = boxExit(b, a.x + a.w / 2, a.y + a.h / 2);
      items.push({
        t: 'line',
        x1: round(p.x),
        y1: round(p.y),
        x2: round(q.x),
        y2: round(q.y),
        cls: 'edge',
      });
      items.push({
        t: 'path',
        d: arrowHead(q.x, q.y, Math.atan2(q.y - p.y, q.x - p.x)),
        cls: 'arrow',
      });
      if (e.label) edgeLabel((p.x + q.x) / 2, (p.y + q.y) / 2, e.label);
      continue;
    }
    // Skipping layers or going back: leave and enter on the far side, around the nodes between.
    const bulge = far + 24 + lane * 18;
    lane++;
    const p = down ? { x: a.x + a.w, y: a.y + a.h / 2 } : { x: a.x + a.w / 2, y: a.y + a.h };
    const q = down ? { x: b.x + b.w, y: b.y + b.h / 2 } : { x: b.x + b.w / 2, y: b.y + b.h };
    const c1 = down ? { x: bulge, y: p.y } : { x: p.x, y: bulge };
    const c2 = down ? { x: bulge, y: q.y } : { x: q.x, y: bulge };
    items.push({
      t: 'path',
      d: `M${round(p.x)},${round(p.y)}C${round(c1.x)},${round(c1.y)} ${round(c2.x)},${round(c2.y)} ${round(q.x)},${round(q.y)}`,
      cls: 'edge',
    });
    items.push({
      t: 'path',
      d: arrowHead(q.x, q.y, Math.atan2(q.y - c2.y, q.x - c2.x)),
      cls: 'arrow',
    });
    const mid = {
      x: (p.x + 3 * c1.x + 3 * c2.x + q.x) / 8,
      y: (p.y + 3 * c1.y + 3 * c2.y + q.y) / 8,
    };
    if (e.label) edgeLabel(mid.x, mid.y, e.label);
    const reach = Math.ceil(
      down ? mid.x + (e.label ? textWidth(e.label) / 2 + 8 : 0) + 8 : mid.y + 18,
    );
    if (down) width = Math.max(width, reach);
    else height = Math.max(height, reach);
  }
  for (const n of spec.nodes) {
    const b = box.get(n.id)!;
    if (n.shape === 'diamond') {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      items.push({
        t: 'path',
        d: `M${round(cx)},${round(b.y)}L${round(b.x + b.w)},${round(cy)}L${round(cx)},${round(b.y + b.h)}L${round(b.x)},${round(cy)}Z`,
        cls: 'node',
      });
    } else
      items.push({
        t: 'rect',
        x: round(b.x),
        y: round(b.y),
        w: b.w,
        h: b.h,
        rx: n.shape === 'round' ? b.h / 2 : 6,
        cls: 'node',
      });
    items.push({
      t: 'text',
      x: round(b.x + b.w / 2),
      y: round(b.y + b.h / 2 + 4),
      text: clip(n.label, b.w - (n.shape === 'diamond' ? 28 : 14)),
      cls: 'node-label',
      anchor: 'middle',
    });
    const outgoing = spec.edges.filter((e) => e.from === n.id);
    targets.push({
      x: round(b.x),
      y: round(b.y),
      w: b.w,
      h: b.h,
      label: n.label,
      rows: outgoing.map((e) => ({
        series: null,
        name: e.label ?? 'then',
        value: label.get(e.to) ?? e.to,
      })),
    });
  }
  return {
    width,
    height,
    summary: `Flowchart with ${spec.nodes.length} steps and ${spec.edges.length} connections`,
    items,
    targets,
    table: {
      columns: ['From', 'To', 'Label'],
      rows: spec.edges.map((e) => [
        label.get(e.from) ?? e.from,
        label.get(e.to) ?? e.to,
        e.label ?? '',
      ]),
    },
  };
}

function layoutSequence(spec: SequenceSpec): VizScene {
  const colW = Math.max(
    120,
    ...spec.participants.map((p) => textWidth(p.label) + 32),
    ...spec.messages.map((m) => Math.min(260, textWidth(m.label) + 24)),
  );
  const boxH = 32;
  const top = 12;
  const rowH = 40;
  const width = Math.ceil(colW * spec.participants.length + 24);
  const height = Math.ceil(top + boxH + 24 + spec.messages.length * rowH + 12);
  const cx = new Map(spec.participants.map((p, i) => [p.id, 12 + colW * i + colW / 2]));
  const items: VizItem[] = [];
  const targets: VizTarget[] = [];
  for (const p of spec.participants) {
    const x = cx.get(p.id)!;
    const w = Math.min(colW - 16, textWidth(p.label) + 24);
    items.push({
      t: 'line',
      x1: round(x),
      y1: top + boxH,
      x2: round(x),
      y2: height - 8,
      cls: 'lifeline',
    });
    items.push({ t: 'rect', x: round(x - w / 2), y: top, w, h: boxH, rx: 6, cls: 'node' });
    items.push({
      t: 'text',
      x: round(x),
      y: top + boxH / 2 + 4,
      text: clip(p.label, w - 12),
      cls: 'node-label',
      anchor: 'middle',
    });
    targets.push({ x: round(x - w / 2), y: top, w, h: boxH, label: p.label, rows: [] });
  }
  const name = new Map(spec.participants.map((p) => [p.id, p.label]));
  spec.messages.forEach((m, i) => {
    const y = top + boxH + 24 + i * rowH + 18;
    const a = cx.get(m.from)!;
    const b = cx.get(m.to)!;
    const cls = m.reply ? 'edge reply' : 'edge';
    if (m.from === m.to) {
      items.push({
        t: 'path',
        d: `M${round(a)},${round(y - 8)}H${round(a + 36)}V${round(y + 8)}H${round(a + 4)}`,
        cls,
      });
      items.push({ t: 'path', d: arrowHead(a, y + 8, Math.PI), cls: 'arrow' });
      items.push({
        t: 'text',
        x: round(a + 42),
        y: round(y + 4),
        text: clip(m.label, colW - 50),
        cls: 'edge-label',
        anchor: 'start',
      });
    } else {
      const dir = b > a ? 1 : -1;
      items.push({ t: 'line', x1: round(a), y1: y, x2: round(b - dir * 2), y2: y, cls });
      items.push({ t: 'path', d: arrowHead(b, y, dir > 0 ? 0 : Math.PI), cls: 'arrow' });
      items.push({
        t: 'text',
        x: round((a + b) / 2),
        y: y - 7,
        text: clip(m.label, Math.abs(b - a) - 8),
        cls: 'edge-label',
        anchor: 'middle',
      });
    }
    const x0 = Math.min(a, b);
    targets.push({
      x: round(x0),
      y: y - 18,
      w: Math.max(40, Math.abs(b - a)),
      h: 26,
      label: `${name.get(m.from) ?? m.from} to ${name.get(m.to) ?? m.to}`,
      rows: [{ series: null, name: m.reply ? 'reply' : 'message', value: m.label || '(no text)' }],
    });
  });
  return {
    width,
    height,
    summary: `Sequence diagram with ${spec.participants.length} participants and ${spec.messages.length} messages`,
    items,
    targets,
    table: {
      columns: ['From', 'To', 'Message'],
      rows: spec.messages.map((m) => [name.get(m.from) ?? m.from, name.get(m.to) ?? m.to, m.label]),
    },
  };
}

// ---- static SVG ------------------------------------------------------------------------------------

/** Escape text for XML and HTML text or a double-quoted attribute. */
export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

const LIGHT = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#6250d6',
  '#e34948',
];
const DARK = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
];

/** The ordered categorical palette (validated light and dark steps), for static output. */
export const VIZ_PALETTE = { light: LIGHT, dark: DARK } as const;

function staticStyle(): string {
  const series = (p: readonly string[]) =>
    p
      .map(
        (c, i) =>
          `.nv-viz .mark.s${i},.nv-viz .dot.s${i}{fill:${c}}.nv-viz .line.s${i}{stroke:${c}}`,
      )
      .join('');
  const ink = (o: {
    text: string;
    muted: string;
    grid: string;
    axis: string;
    surface: string;
    node: string;
  }) =>
    `.nv-viz{--nv-surface:${o.surface}}.nv-viz .bg{fill:${o.surface}}.nv-viz text{fill:${o.muted}}.nv-viz .legend,.nv-viz .node-label,.nv-viz .value{fill:${o.text}}` +
    `.nv-viz .grid{stroke:${o.grid}}.nv-viz .axis{stroke:${o.axis}}.nv-viz .node{fill:${o.node};stroke:${o.axis}}` +
    `.nv-viz .edge,.nv-viz .lifeline{stroke:${o.muted}}.nv-viz .arrow{fill:${o.muted}}.nv-viz .edge-label-bg{fill:${o.surface}}` +
    `.nv-viz .dot{stroke:${o.surface}}.nv-viz .gap{stroke:${o.surface}}`;
  return (
    `.nv-viz{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:${FONT}px}` +
    '.nv-viz .grid,.nv-viz .axis,.nv-viz .edge,.nv-viz .lifeline{stroke-width:1;fill:none}' +
    '.nv-viz .line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}' +
    '.nv-viz .dot{stroke-width:2}.nv-viz .gap{stroke-width:2}.nv-viz .reply,.nv-viz .lifeline{stroke-dasharray:4 4}' +
    '.nv-viz .on-mark{fill:#fff;font-weight:600}.nv-viz .value{font-weight:600}' +
    ink({
      text: '#0b0b0b',
      muted: '#52514e',
      grid: '#e1e0d9',
      axis: '#c3c2b7',
      surface: '#fcfcfb',
      node: '#f0efec',
    }) +
    series(LIGHT) +
    '@media (prefers-color-scheme: dark){' +
    ink({
      text: '#f0efec',
      muted: '#c3c2b7',
      grid: '#2c2c2a',
      axis: '#383835',
      surface: '#1a1a19',
      node: '#2c2c2a',
    }) +
    series(DARK) +
    '}'
  );
}

const n1 = (v: number) => (Number.isFinite(v) ? String(round(v)) : '0');

/**
 * A scene as a standalone SVG document with its own styles: for sites and downloads. Every text
 * is escaped; numbers are formatted from numbers, so nothing in a spec can add markup or script.
 */
export function sceneToSvg(scene: VizScene, title?: string | null): string {
  const out: string[] = [];
  const label = title ? `${title}. ${scene.summary}` : scene.summary;
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" class="nv-viz" viewBox="0 0 ${n1(scene.width)} ${n1(scene.height)}" width="${n1(scene.width)}" height="${n1(scene.height)}" role="img" aria-label="${escapeXml(label)}">`,
  );
  out.push(`<title>${escapeXml(label)}</title><style>${staticStyle()}</style>`);
  // Its own surface, so a downloaded SVG reads the same on any background.
  out.push(`<rect class="bg" width="100%" height="100%"/>`);
  for (const it of scene.items) {
    const cls = escapeXml(it.cls);
    switch (it.t) {
      case 'rect':
        out.push(
          `<rect class="${cls}" x="${n1(it.x)}" y="${n1(it.y)}" width="${n1(it.w)}" height="${n1(it.h)}"${it.rx ? ` rx="${n1(it.rx)}"` : ''}/>`,
        );
        break;
      case 'path':
        // Paths are built from numbers and the letters M, L, H, V, Q, C, A and Z only.
        out.push(`<path class="${cls}" d="${it.d.replace(/[^MLHVQCAZ0-9.,\s-]/g, '')}"/>`);
        break;
      case 'line':
        out.push(
          `<line class="${cls}" x1="${n1(it.x1)}" y1="${n1(it.y1)}" x2="${n1(it.x2)}" y2="${n1(it.y2)}"/>`,
        );
        break;
      case 'circle':
        out.push(`<circle class="${cls}" cx="${n1(it.cx)}" cy="${n1(it.cy)}" r="${n1(it.r)}"/>`);
        break;
      case 'text':
        out.push(
          `<text class="${cls}" x="${n1(it.x)}" y="${n1(it.y)}" text-anchor="${it.anchor}">${escapeXml(it.text)}</text>`,
        );
        break;
    }
  }
  out.push('</svg>');
  return out.join('');
}

/** A static HTML table of a scene's numbers (sites and downloads). */
export function tableToHtml(table: VizTable, caption: string): string {
  const head = table.columns.map((c) => `<th scope="col">${escapeXml(c)}</th>`).join('');
  const body = table.rows
    .map((r) => `<tr>${r.map((c) => `<td>${escapeXml(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table class="nv-viz-table"><caption>${escapeXml(caption)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
