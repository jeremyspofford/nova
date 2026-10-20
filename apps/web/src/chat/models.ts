// Model choices for the composer (FR-023, FR-024, FR-221): the picker's groups (presets first,
// then models by provider), the stops of the Faster to Smarter control, and the model a new chat
// starts with.
import { defineMessages } from '@nova/i18n';
import type { ModelView, Preset } from '@nova/shared';
import type { SelectOption } from '@nova/ui';
import { PROVIDER_NAMES } from '../providers/names.ts';

export const MODEL_TEXT = defineMessages('chat.models', {
  uses: 'Uses {model}',
  presets: 'Presets',
  unavailable: '{model} (unavailable)',
  /** A second account of the same provider: "OpenAI (2)". */
  nth: '{provider} ({n})',
});

export interface PresetStop {
  ref: string;
  label: string;
  rank: number;
  /** The model the preset runs on now, shown as a description. */
  description?: string;
}

/** Enabled presets ordered from faster to smarter. Without ranks, keep the Hub's order. */
export function presetStops(models: ModelView[], presets: Preset[]): PresetStop[] {
  const rank = new Map(presets.map((p) => [`preset:${p.id}`, p.rank]));
  const target = new Map(presets.map((p) => [`preset:${p.id}`, p.targets[0]]));
  return models
    .filter((m) => m.kind === 'preset' && !m.disabledReason)
    .map((m, i) => {
      const first = target.get(m.ref);
      const runsOn = first ? models.find((x) => x.ref === first)?.label : undefined;
      return {
        ref: m.ref,
        label: m.label,
        rank: rank.get(m.ref) ?? 1000 + i,
        ...(runsOn ? { description: MODEL_TEXT.uses({ model: runsOn }) } : {}),
      };
    })
    .sort((a, b) => a.rank - b.rank);
}

/** Picker groups: a "Presets" group first, then one group per provider account or node. */
export function modelGroups(models: ModelView[]): { label: string; options: SelectOption[] }[] {
  const groups = new Map<string, { label: string; options: SelectOption[] }>();
  for (const m of models) {
    const key =
      m.kind === 'preset'
        ? 'preset'
        : m.source === 'node'
          ? `node:${m.nodeId ?? m.providerAccountId}`
          : `acct:${m.providerAccountId}`;
    const g = groups.get(key) ?? {
      label:
        m.kind === 'preset'
          ? MODEL_TEXT.presets
          : (PROVIDER_NAMES[m.provider] ?? String(m.provider)),
      options: [],
    };
    g.options.push(
      m.disabledReason
        ? {
            value: m.ref,
            label: MODEL_TEXT.unavailable({ model: m.label }),
            disabled: true,
            title: m.disabledReason,
          }
        : { value: m.ref, label: m.label },
    );
    groups.set(key, g);
  }
  // Presets lead even if the Hub listed them later; two accounts of one kind get told apart.
  const preset = groups.get('preset');
  const seen = new Map<string, number>();
  const rest = [...groups.entries()]
    .filter(([k]) => k !== 'preset')
    .map(([, g]) => {
      const n = (seen.get(g.label) ?? 0) + 1;
      seen.set(g.label, n);
      return n === 1 ? g : { ...g, label: MODEL_TEXT.nth({ provider: g.label, n }) };
    });
  return preset ? [preset, ...rest] : rest;
}

/**
 * The model a new chat uses when neither the chat nor the `chat.defaultModel` setting names one:
 * the middle enabled preset (Balanced in the built-in set, docs/07 §8.1), else the first usable
 * model.
 */
export function fallbackModel(models: ModelView[], presets: Preset[]): ModelView | null {
  const stops = presetStops(models, presets);
  const balanced = stops.find((s) => s.ref === 'preset:balanced');
  const pick = balanced ?? stops[Math.floor((stops.length - 1) / 2)];
  if (pick) return models.find((m) => m.ref === pick.ref) ?? null;
  return models.find((m) => !m.disabledReason) ?? null;
}

/** True when the ref names a disabled entry (unknown refs are left to the Hub to judge). */
export function isDisabled(models: ModelView[], ref: string | null): boolean {
  return !!ref && !!models.find((m) => m.ref === ref)?.disabledReason;
}
