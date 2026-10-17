// Per-mode pane layouts (FR-005): read once from `workspace.layout` when the workspace starts,
// and written back shortly after each change, so the arrangement survives a restart. A saved
// layout that does not parse falls back to the default for that mode.
import { useCallback, useEffect, useRef, useState } from 'react';
import { MODES, type Mode } from '../router.ts';
import { useSettings } from '../settings.tsx';
import { defaultLayout, parseLayout, type ModeLayout } from './model.ts';

export type Layouts = Record<Mode, ModeLayout>;

export function layoutsFrom(saved: Record<string, unknown>): Layouts {
  return Object.fromEntries(
    MODES.map((m) => [m, parseLayout(saved[m]) ?? defaultLayout()]),
  ) as Layouts;
}

export interface LayoutsStore {
  layouts: Layouts;
  update: (mode: Mode, fn: (layout: ModeLayout) => ModeLayout) => void;
}

export function useLayouts(saveDelayMs = 300): LayoutsStore {
  const settings = useSettings();
  const [layouts, setLayouts] = useState<Layouts>(() =>
    layoutsFrom(settings.get('workspace.layout').value),
  );
  const saved = useRef(JSON.stringify(layouts));
  const store = useRef(settings);
  useEffect(() => {
    store.current = settings;
  });

  const update = useCallback((mode: Mode, fn: (layout: ModeLayout) => ModeLayout) => {
    setLayouts((all) => {
      const next = fn(all[mode]);
      return next === all[mode] ? all : { ...all, [mode]: next };
    });
  }, []);

  useEffect(() => {
    const json = JSON.stringify(layouts);
    if (json === saved.current) return;
    const write = () => {
      saved.current = json;
      store.current
        .set('workspace.layout', JSON.parse(json) as Record<string, unknown>)
        .catch(() => {
          // Kept in memory; the next change tries again.
          saved.current = '';
        });
    };
    const t = setTimeout(write, saveDelayMs);
    return () => {
      clearTimeout(t);
    };
  }, [layouts, saveDelayMs]);

  // Leaving the workspace saves at once instead of dropping the pending write.
  const latest = useRef(layouts);
  useEffect(() => {
    latest.current = layouts;
  });
  useEffect(
    () => () => {
      const json = JSON.stringify(latest.current);
      if (json === saved.current) return;
      saved.current = json;
      store.current
        .set('workspace.layout', JSON.parse(json) as Record<string, unknown>)
        .catch(() => undefined);
    },
    [],
  );

  return { layouts, update };
}
