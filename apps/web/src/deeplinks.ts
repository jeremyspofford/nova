// Deep links (FR-007): `nova://…` and `web+nova://…` URLs map onto the web UI's routes. The
// installed PWA registers `web+nova` as a protocol handler that opens /open?url=<link>.

/** The app path for a deep link, or null when the link is not one Nova understands. */
export function deepLinkPath(_url: string): string | null {
  return null;
}
