/**
 * The chat's whole-message slash command for clearing history.
 *
 * A message that IS exactly the command — `/clear`, or its alias `/reset`,
 * case-insensitive and ignoring surrounding whitespace — is a command, not a
 * turn: the send path clears the chat instead of streaming it to the model. A
 * message that merely CONTAINS "/clear" somewhere in it ("remind me to run
 * /clear later") is an ordinary message and sends normally, so the command can
 * never be triggered by accident from the middle of a sentence.
 */
export const CLEAR_COMMANDS = ['/clear', '/reset'] as const

export function isClearCommand(text: string): boolean {
  const whole = text.trim().toLowerCase()
  return (CLEAR_COMMANDS as readonly string[]).includes(whole)
}
