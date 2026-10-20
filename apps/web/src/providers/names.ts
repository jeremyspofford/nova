// Display names for provider kinds (and the pseudo-providers of presets and compute nodes). Brand
// names stay as they are in most languages; the messages let a translator keep or adapt them.
import { defineMessages } from '@nova/i18n';

const NAMES = defineMessages('providers.names', {
  mock: 'Mock',
  openai_compatible: 'OpenAI-compatible',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  llamacpp: 'llama.cpp',
  preset: 'Presets',
  node: 'Compute node',
});

/** By provider kind; each read translates in the active locale. Unknown kinds are undefined. */
export const PROVIDER_NAMES: Readonly<Record<string, string>> = NAMES;
