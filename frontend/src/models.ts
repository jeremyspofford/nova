/** Model pickers: which machine is this model going to run on?
 *
 * Every picker in the app used to render a flat list of bare names, so
 * `qwen3:8b` and `anthropic/claude-sonnet-4.6` sat side by side with nothing
 * saying that one runs on the box under the desk for free and the other
 * leaves the house and bills per token. That is the single most consequential
 * fact about a model here — Nova's whole stance is local-first — and it was
 * the one thing the list did not show.
 *
 * Grouped with <optgroup> rather than badged, deliberately. A native <option>
 * cannot contain markup, so a badge means replacing the select with a custom
 * listbox; the mobile drawer's native select is exactly what gives iOS its
 * wheel picker, and swapping that for a div would be a regression only
 * testable on a phone. <optgroup> is native everywhere, keeps the wheel, and
 * needed no change to any of the four call sites beyond the option loop.
 *
 * Local providers sort FIRST. That is not alphabetical accident: local-model
 * users are the primary audience, and the top of a picker is a
 * recommendation.
 */

import type { ModelInfo } from './api';

/** Slugs whose base_url is a machine you own. `custom` is deliberately not
 *  here — it can point anywhere, and guessing "local" for something that
 *  might bill per token is the expensive direction to be wrong in. */
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'vllm']);

/** Display names for the providers Nova ships presets for
 *  (backend/app/llm/providers.py PRESETS). Anything registered later falls
 *  back to its own slug, which is what the operator typed. */
const PROVIDER_NAMES: Record<string, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  vllm: 'vLLM',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  groq: 'Groq',
  together: 'Together AI',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  xai: 'xAI',
  huggingface: 'HuggingFace',
  custom: 'Custom endpoint',
};

export const isLocalProvider = (slug: string) => LOCAL_PROVIDERS.has(slug);

export function providerName(slug: string): string {
  return PROVIDER_NAMES[slug] ?? (slug ? slug[0].toUpperCase() + slug.slice(1) : 'Other');
}

/** The group heading. Says where it runs before it says who makes it,
 *  because that is the part that costs money or doesn't. */
export function providerGroupLabel(slug: string): string {
  return isLocalProvider(slug)
    ? `On this machine — ${providerName(slug)}`
    : `Cloud — ${providerName(slug)}`;
}

export interface ModelGroup { slug: string; label: string; models: ModelInfo[] }

/** Group by provider, local first, then alphabetically by display name.
 *  Order WITHIN a group is left as the caller gave it — the backend already
 *  sorts, and re-sorting here would fight it. */
export function groupModels(models: ModelInfo[]): ModelGroup[] {
  const by = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const slug = m.provider || 'other';
    const list = by.get(slug);
    if (list) list.push(m);
    else by.set(slug, [m]);
  }
  return [...by.entries()]
    .map(([slug, ms]) => ({ slug, label: providerGroupLabel(slug), models: ms }))
    .sort((a, b) => {
      const la = isLocalProvider(a.slug), lb = isLocalProvider(b.slug);
      if (la !== lb) return la ? -1 : 1;
      return providerName(a.slug).localeCompare(providerName(b.slug));
    });
}
