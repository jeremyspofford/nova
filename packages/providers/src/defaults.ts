// Default endpoints per provider kind (docs/07 §3, §12). A provider account's own base URL
// always wins; these apply when it has none.
export const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  llamacpp: 'http://127.0.0.1:8080/v1',
} as const;

export type DefaultBaseKind = keyof typeof DEFAULT_BASE_URLS;

export function hasDefaultBase(kind: string): kind is DefaultBaseKind {
  return Object.hasOwn(DEFAULT_BASE_URLS, kind);
}
