// Public semantic state approved by the person. Not a permission grant: access, confirmation,
// readiness and policy still apply. Drivers compare it inside serialization, before effects.
export interface ServiceAssignment { version: string; want: 'alongside'|'live'|'stopped'; at: string }
export interface ServiceExpectedState { live: string|null; previous: string|null; assigned: ServiceAssignment|null }
const version = (v: unknown): boolean => v === null || typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const keys = (v: unknown, fields: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
export function validServiceExpected(v: unknown): v is ServiceExpectedState {
  if (!keys(v, ['live', 'previous', 'assigned']) || !version(v.live) || !version(v.previous)) return false;
  const a = v.assigned;
  return a === null || keys(a, ['version', 'want', 'at']) && a.version !== null && version(a.version) && typeof a.want === 'string' && ['alongside', 'live', 'stopped'].includes(a.want) && typeof a.at === 'string' && a.at.length <= 32 && Number.isFinite(Date.parse(a.at)) && new Date(a.at).toISOString() === a.at;
}
export function serviceExpected(s: { live: string|null; previous: string|null; assigned?: ServiceAssignment|null }): ServiceExpectedState {
  return { live: s.live, previous: s.previous, assigned: s.assigned ? { version: s.assigned.version, want: s.assigned.want, at: s.assigned.at } : null };
}
export function sameServiceExpected(expected: unknown, actual: Parameters<typeof serviceExpected>[0]): boolean {
  if (!validServiceExpected(expected)) return false;
  const a = serviceExpected(actual);
  return expected.live === a.live && expected.previous === a.previous && (expected.assigned === null ? a.assigned === null : a.assigned !== null && expected.assigned.version === a.assigned.version && expected.assigned.want === a.assigned.want && expected.assigned.at === a.assigned.at);
}
export const SERVICE_CHANGED = 'The approved service state changed. Refresh and review its live, previous and assignment state again.';
