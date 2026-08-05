/** The Vault's one graph fetch.
 *
 *  `getMemoryGraph()` has existed in `src/api.ts` since the brain views landed
 *  and had zero callers; the Vault is its first. It returns the raw memory
 *  graph — 262 nodes, 279 edges, 186 KB, 40ms — which is small enough to hold
 *  whole and derive backlinks, titles and tags from, and is why the Vault
 *  needs no new endpoints.
 *
 *  IT DOES NOT POLL, and that is deliberate. `<Brain/>` is mounted permanently
 *  OUTSIDE the router (AppShell.tsx), so its 20s `/brain/graph` poll keeps
 *  running behind this surface — and `memory.graph()` re-reads and parses
 *  every file on disk on every call. A second interval would double that
 *  forever, for data that only changes when the operator or an ingest writes.
 *  The operator's own writes call `refresh()` from the save path; for the
 *  other case there is a refresh control. Do not "fix" this with a setInterval.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getMemoryGraph } from '../api';
import { buildIndex, type VaultIndex } from './graph/model';
import { seedColors } from './graph/colors';

export interface VaultGraphState {
  /** null until the first fetch lands — panes render skeletons, never "0". */
  index: VaultIndex | null;
  error: string;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useVaultGraph(): VaultGraphState {
  const [raw, setRaw] = useState<Awaited<ReturnType<typeof getMemoryGraph>> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const g = await getMemoryGraph();
      if (!alive.current) return;
      setRaw(g);
      setError('');
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; };
  }, [refresh]);

  const index = useMemo(() => {
    if (!raw) return null;
    const built = buildIndex(raw.nodes, raw.edges);
    seedColors(built.nodes);
    return built;
  }, [raw]);

  return { index, error, loading, refresh };
}
