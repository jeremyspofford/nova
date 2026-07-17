/** Human-readable Title Case names for kebab/snake-case identifiers.
 *
 * Display-only: values sent to the API stay canonical (`refresh-stale-knowledge`,
 * `list_agents`); this transforms what the user reads ("Refresh Stale Knowledge",
 * "List Agents"). Preserves interior casing so already-readable titles pass
 * through cleanly.
 */

const ACRONYMS = new Set(['url', 'api', 'http', 'db', 'id', 'llm', 'mcp', 'ai']);

// The 'main' agent IS the assistant — everywhere the UI names agents, it
// should wear her configured name, not the internal id. Kept live by
// useAssistantName (mounted with the chat) via _setAssistantName.
let assistantName = 'Nova';

export function _setAssistantName(name: string) {
  assistantName = name;
}

/** Agent display name: 'main' → the assistant's name; others Title Case. */
export function agentDisplayName(name: string): string {
  return name === 'main' ? assistantName : displayName(name);
}

export function displayName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => ACRONYMS.has(w.toLowerCase())
      ? w.toUpperCase()
      : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
