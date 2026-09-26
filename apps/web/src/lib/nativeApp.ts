/**
 * Where the Nova app lives in each store (S47). Both null: there is no Nova
 * app yet. The day one ships, its listing goes here AND in
 * services/core/app/native_app.py — services/core/tests/test_native_app.py
 * pins the two equal, so the /app page and her words cannot disagree about
 * whether an app exists.
 */
export const NATIVE_APP_LINKS: { ios: string | null; android: string | null } = {
  ios: null,
  android: null,
}
