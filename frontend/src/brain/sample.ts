/** Small static dataset for theme preview thumbnails. */

import type { GraphNode, GraphEdge } from '../api';

const now = Date.now() / 1000;

export const SAMPLE_NODES: GraphNode[] = [
  { id: 't1', label: 'Bear Mountain', type: 'topic', mtime: now, tags: ['parks'] },
  { id: 't2', label: 'Trailside Zoo', type: 'topic', mtime: now - 86400, tags: ['parks'] },
  { id: 't3', label: 'AI News', type: 'topic', mtime: now - 172800, tags: ['tech'] },
  { id: 't4', label: 'OpenRouter', type: 'topic', mtime: now - 259200, tags: ['tech'] },
  { id: 's1', label: 'Weather advice', type: 'skill', mtime: now - 86400 },
  { id: 's2', label: 'Table format', type: 'skill', mtime: now - 172800 },
  { id: 'j1', label: 'Journal', type: 'journal', mtime: now },
  { id: 'j2', label: 'Journal', type: 'journal', mtime: now - 86400 },
  { id: 'src1', label: 'Wikipedia', type: 'source', mtime: now - 259200 },
  { id: 'nova', label: 'Nova', type: 'core', mtime: now },
  { id: 'user', label: 'You', type: 'user', mtime: now },
  { id: 'a1', label: 'Ingestion', type: 'agent', mtime: now },
  { id: 'tool1', label: 'Web Search', type: 'tool', mtime: now },
  { id: 'auto1', label: 'News digest', type: 'automation', mtime: now, enabled: true, interval_minutes: 720 },
];

export const SAMPLE_EDGES: GraphEdge[] = [
  { source: 't1', target: 't2', kind: 'tag' },
  { source: 't3', target: 't4', kind: 'tag' },
  { source: 't1', target: 'src1', kind: 'link' },
  { source: 't2', target: 's1', kind: 'link' },
  { source: 'nova', target: 'a1', kind: 'platform' },
  { source: 'nova', target: 'user', kind: 'bond' },
  { source: 'a1', target: 'tool1', kind: 'grant' },
  { source: 'auto1', target: 'a1', kind: 'platform' },
];
