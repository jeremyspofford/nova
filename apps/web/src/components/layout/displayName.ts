/**
 * The short name a person is called in the UI.
 *
 * `people.name` is whatever was typed at registration, and on this instance
 * that is an email address — so the sidebar footer read
 * "jeremyspofford@gmail…." in a 240px column, which is an identifier, not a
 * name. The full identity still appears, once, at the top of the account
 * menu (the way Claude's does); the footer says what to call him.
 *
 * DERIVED, never stored. There is no route that sets a display name and a
 * field that silently does nothing is worse than no field — so this reads
 * whatever `name` holds and does the obvious thing with it. The day core
 * grows a real display name, this stops being consulted rather than being
 * migrated.
 */

/** The first name, or the best available stand-in. Never an empty string:
 *  an avatar and a blank label is worse than a clumsy label. */
export function displayName(name: string): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return 'Signed in'

  // An email: everything before the @ is the part that identifies a person,
  // and the domain never is.
  const local = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed
  // "jeremy.spofford", "jeremy_spofford", "jeremy+nova", "Jeremy Spofford"
  // — all of them lead with the given name.
  const first = local.split(/[\s._+-]+/).filter(Boolean)[0] ?? local
  return first.charAt(0).toUpperCase() + first.slice(1)
}

/** Two letters for the avatar. Prefers real initials, falls back to the
 *  first two characters of whatever we can show. */
export function initials(name: string): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return '?'
  const local = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed
  const parts = local.split(/[\s._+-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return local.slice(0, 2).toUpperCase()
}
