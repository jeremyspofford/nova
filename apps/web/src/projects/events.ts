// Projects change in a few places (the list, a project page, the New project dialog) and are
// shown in the sidebar. There is no shared store for them, so writers announce a change with a
// window event and readers refetch (FR-034).
import { useEffect, useState } from 'react';
import type { ProjectView } from '@nova/shared';
import { useServices } from '../services.tsx';

const EVENT = 'nova:projects-changed';

export function projectsChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function onProjectsChanged(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}

/** The most recently updated projects, refreshed whenever a project changes. */
export function useRecentProjects(limit = 5): ProjectView[] {
  const { api } = useServices();
  const [items, setItems] = useState<ProjectView[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.listProjects().then(
        ({ items: list }) => {
          if (!alive) return;
          const sorted = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          setItems(sorted.slice(0, limit));
        },
        // The sidebar still links to Projects; the page itself reports load errors.
        () => undefined,
      );
    };
    load();
    const off = onProjectsChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, [api, limit]);
  return items;
}
