/**
 * The chat's slash commands, as one list of data — the single source the
 * whole-message parser, the input autocomplete, and `/help` all read. Adding a
 * command here makes it run, autocomplete, and appear in `/help` at once; there
 * is nowhere else to register it, so the three can never drift apart.
 *
 * A command is only ever triggered as a WHOLE message: a message that IS
 * exactly `/clear` (case-insensitive, surrounding whitespace ignored) is a
 * command, but one that merely CONTAINS "/clear" somewhere in it ("remind me to
 * run /clear later") is an ordinary message and sends normally — so a command
 * can never fire by accident from the middle of a sentence. This rule lives in
 * `matchCommand` below and is the same one the old lib/clearCommand.ts enforced
 * for /clear alone, generalized to the registry.
 */

/** What a command's `run` is handed — the side-effects it may perform. Kept
 * deliberately small: `clearChat` is the store's own clear action, and
 * `appendLocalMessage` drops a local (un-sent, no model round-trip) row into
 * the transcript, which is all `/help` needs to print itself. */
export interface CommandContext {
  clearChat: () => void | Promise<void>
  appendLocalMessage: (text: string) => void
}

export interface Command {
  /** The primary invocation, leading slash included, e.g. "/clear". */
  name: string
  /** Additional whole-message spellings that run the same command, leading
   * slash included, e.g. ["/reset"]. */
  aliases?: readonly string[]
  /** A precise one-line description shown in the autocomplete and by /help. */
  summary: string
  run: (ctx: CommandContext) => void
}

/** Every token that triggers a command — its name and any aliases — lowercased
 * so matching is case-insensitive. */
export function commandTokens(cmd: Command): string[] {
  return [cmd.name, ...(cmd.aliases ?? [])].map(token => token.toLowerCase())
}

/**
 * Render the registry as a help listing — each command's name, its aliases, and
 * its summary. Derived by iterating whatever list it is given (the registry, in
 * practice), never a hand-maintained copy, so a newly registered command shows
 * up here for free.
 */
export function formatCommandHelp(commands: readonly Command[]): string {
  const lines = commands.map(cmd => {
    const names = [cmd.name, ...(cmd.aliases ?? [])].join(', ')
    return `${names} — ${cmd.summary}`
  })
  return ['Available commands:', '', ...lines].join('\n')
}

/**
 * The registry. `/help` references `COMMANDS` inside its `run` (a closure that
 * only executes long after this array is fully initialized, so the
 * self-reference is safe), so the help listing is always the live registry.
 */
export const COMMANDS: readonly Command[] = [
  {
    name: '/clear',
    aliases: ['/reset'],
    summary: "Clear this conversation's messages.",
    run: ctx => {
      // Fire-and-forget, exactly as the send path did before: clearChat empties
      // the store on the clear API's ok, never before (no fake success).
      void ctx.clearChat()
    },
  },
  {
    name: '/help',
    aliases: ['/?'],
    summary: 'List the available commands.',
    run: ctx => ctx.appendLocalMessage(formatCommandHelp(COMMANDS)),
  },
]

/**
 * The whole-message parser. Returns the command a message invokes, or null when
 * it is an ordinary message. Trimmed and lowercased, the message must EQUAL a
 * command's name or one of its aliases — mid-text "/clear" never matches.
 */
export function matchCommand(text: string): Command | null {
  const whole = text.trim().toLowerCase()
  if (!whole.startsWith('/')) return null
  return COMMANDS.find(cmd => commandTokens(cmd).includes(whole)) ?? null
}

/**
 * True when the input is a leading-slash token the autocomplete may complete —
 * the first (and only) token starts with "/". Leading whitespace is tolerated,
 * but any whitespace inside the token (" /clear now") means the operator has
 * moved past the command name, so the autocomplete stands down and the message
 * sends normally. This is what keeps a mid-text "/" from ever triggering it.
 */
export function isSlashQuery(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith('/') && !/\s/.test(trimmed)
}

/**
 * The commands to offer for the current input, or [] when the autocomplete must
 * not show. A command matches when its name or any alias starts with the typed
 * slash-token (case-insensitive); a bare "/" offers everything. Returns [] for
 * anything that is not a leading-slash token, so a normal message shows no
 * dropdown.
 */
export function autocompleteMatches(text: string): Command[] {
  if (!isSlashQuery(text)) return []
  const token = text.trimStart().toLowerCase()
  return COMMANDS.filter(cmd => commandTokens(cmd).some(t => t.startsWith(token)))
}
