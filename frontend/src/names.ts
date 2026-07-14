/** Human-readable Title Case names for kebab/snake-case identifiers.
 *
 * Display-only: values sent to the API stay canonical (`refresh-stale-knowledge`,
 * `list_agents`); this transforms what the user reads ("Refresh Stale Knowledge",
 * "List Agents"). Preserves interior casing so already-readable titles pass
 * through cleanly.
 */

const ACRONYMS = new Set(['url', 'api', 'http', 'db', 'id', 'llm', 'mcp', 'ai']);

export function displayName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => ACRONYMS.has(w.toLowerCase())
      ? w.toUpperCase()
      : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
