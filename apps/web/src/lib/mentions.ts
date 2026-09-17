/**
 * The `@name` mention (S12): the composer's second autocomplete, for the
 * agents. Core is what decides who runs a turn — `chat_stream` applies
 * `^@([a-z][a-z_]{0,25})\b` to the trimmed message and looks the name up;
 * no match, or no such agent, and it is an ordinary Nova turn. Nothing here
 * parses a message for sending: the browser only OFFERS names while the
 * owner is still typing the token, exactly the way lib/commands.ts's
 * `isSlashQuery` offers slash commands.
 *
 * The same leading-token discipline, then: the input must BE a leading `@`
 * token — leading whitespace tolerated, but any whitespace after the `@`
 * ("@coder hi", "@coder ") means the owner has moved past the name, so the
 * menu stands down and Enter sends. A mid-text "@" ("mail @coder") never
 * opens it, the way a mid-text "/" never opens the command menu.
 */

import type { AgentSummary } from './api'

/**
 * The token after a LEADING `@`, or null when the input is not one: "@cod"
 * → "cod", "@" → "" (a bare `@` offers every agent), "@coder hi" → null,
 * "mail @coder" → null.
 */
export function mentionQuery(input: string): string | null {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith('@')) return null
  if (/\s/.test(trimmed)) return null
  return trimmed.slice(1)
}

/**
 * The agents to offer for the current query: those whose name starts with
 * it (case-insensitive on what was typed — agent names are lowercase by
 * core's own grammar). [] when there is no query, or no roster yet — a
 * roster that could not be read is simply a menu that never opens.
 */
export function mentionMatches(
  query: string | null,
  agents: readonly AgentSummary[] | null,
): AgentSummary[] {
  if (query === null || agents === null) return []
  const wanted = query.toLowerCase()
  return agents.filter(agent => agent.name.toLowerCase().startsWith(wanted))
}

/** What the input becomes when an option is chosen: the mention plus the
 * space that closes the token, so the menu stands down and what follows is
 * the message. Never sends — that is still Enter on the whole message. */
export function completeMention(name: string): string {
  return `@${name} `
}
