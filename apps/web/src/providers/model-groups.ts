// Model pickers group options by where a model runs: presets, each provider account, and each
// compute node (FR-023, FR-126, FR-221). Group labels use the provider display names.
import type { ModelView } from '@nova/shared';
import { PROVIDER_NAMES } from './names.ts';

export interface ModelOptionGroup {
  label: string;
  options: { value: string; label: string; disabled?: boolean }[];
}

export function modelGroups(
  models: readonly ModelView[],
  opts: { include?: (m: ModelView) => boolean } = {},
): ModelOptionGroup[] {
  const groups = new Map<string, ModelOptionGroup>();
  for (const m of models) {
    if (opts.include && !opts.include(m)) continue;
    const key = `${m.source}:${m.nodeId ?? m.providerAccountId}`;
    const g = groups.get(key) ?? { label: PROVIDER_NAMES[m.provider] ?? m.provider, options: [] };
    g.options.push({ value: m.ref, label: m.label });
    groups.set(key, g);
  }
  // Two accounts of one kind would otherwise share a label (optgroup labels must be told apart).
  const seen = new Map<string, number>();
  return [...groups.values()].map((g) => {
    const n = (seen.get(g.label) ?? 0) + 1;
    seen.set(g.label, n);
    return n === 1 ? g : { ...g, label: `${g.label} (${n})` };
  });
}
