// How the browser views stay current (FR-086, FR-096, FR-098): the browser area's events on the
// global stream, plus takeover, which pauses the agent browser (FR-087).
export { useHubEvents } from '../spaces/events.ts';
export { eventComputerId } from '../screen/events.ts';

/** The page changed or something was done on it: refresh the frame and the trace. */
export const BROWSER_PAGE_EVENTS = [
  'browser.session.changed',
  'browser.navigated',
  'browser.action',
  'browser.screenshot',
  'computer.takeover.started',
  'computer.takeover.ended',
] as const;

/** A private sign-in form opened or closed (FR-086). */
export const SIGNIN_EVENTS = ['signin.requested', 'signin.completed', 'signin.cancelled'] as const;
