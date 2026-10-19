// Leaving the app for a sign-in provider (FR-113): the Hub answers `POST /api/v1/auth/oidc/start`
// with the provider's address, and the browser goes there. Only http(s) addresses are followed.
// Tests replace `browser.leaveTo` (jsdom does not navigate).

/** True for an absolute http(s) URL without credentials. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
  } catch {
    return false;
  }
}

export const browser = {
  /** Send the browser to `url` (a sign-in provider, or back into the app). */
  leaveTo(url: string): void {
    window.location.assign(url);
  },
};
