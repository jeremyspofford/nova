// Bounded, test-only evidence for the ordinary topology gate. Never changes browser behavior.
import type { ConsoleMessage, Page, Request } from 'playwright-core';

type Stage = { layout: string; theme: string; stage: string };
// This is the public request-event sequence, not proof of committed-document ownership.
type Context = Stage & { navigationSequence: number };
type Observation = Context & { elapsedMs: number };
type StartedRequest = { path: string; method: string; resourceType: string; started: Observation };
type Event =
  | { kind: 'requestfailed'; observed: Observation; request: Omit<StartedRequest, 'started'> & { started: Observation | null }; errorText: string }
  | { kind: 'console-error'; observed: Observation; text: string; location: { path: string; line: number; column: number } };
const LIMIT = 32;
const TEXT_LIMIT = 256;

// Only pathnames leave this helper: no authority, credentials, query or fragment, including
// inside console/error strings. Opaque and non-network schemes have no useful resource path.
function pathOnly(value: string, base?: string): string {
  if (!value) return '';
  try {
    const url = new URL(value, base);
    return /^https?:$/.test(url.protocol) ? url.pathname.slice(0, TEXT_LIMIT) : '[opaque-url]';
  } catch { return '[invalid-url]'; }
}
function safeText(value: string): string {
  return value.replace(/\b[a-z][a-z0-9+.-]*:(?!:)[^\s<>"']+/gi, url => pathOnly(url))
    .replace(/\/[^\s<>"']*/g, path => pathOnly(path, 'http://diagnostic.invalid'))
    .replace(/[?#][^\s<>"']*/g, '')
    .slice(0, TEXT_LIMIT);
}

export function observeTopology(page: Page) {
  let navigationSequence = 0, disposed = false;
  const beganAt = performance.now();
  let stage: Stage = { layout: 'unknown', theme: 'unknown', stage: 'created' };
  const documents: { path: string; observed: Observation }[] = [];
  const events: Event[] = [];
  const pending = new Map<Request, StartedRequest>();
  const counts = { documents: 0, requestfailed: 0, consoleErrors: 0, evictedEvents: 0, evictedPending: 0, evictedDocuments: 0 };
  const context = (): Context => ({ ...stage, navigationSequence });
  const observation = (): Observation => ({ ...context(), elapsedMs: Math.round(performance.now() - beganAt) });
  function append(event: Event) {
    if (events.length === LIMIT) { events.shift(); counts.evictedEvents++; }
    events.push(event);
  }
  function request(request: Request) {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      navigationSequence++; counts.documents++;
      if (documents.length === LIMIT) { documents.shift(); counts.evictedDocuments++; }
      documents.push({ path: pathOnly(request.url()), observed: observation() });
    }
    if (pending.size === LIMIT) { pending.delete(pending.keys().next().value!); counts.evictedPending++; }
    pending.set(request, { path: pathOnly(request.url()), method: safeText(request.method()), resourceType: safeText(request.resourceType()), started: observation() });
  }
  function finished(request: Request) { pending.delete(request); }
  function failed(request: Request) {
    const started = pending.get(request);
    counts.requestfailed++;
    append({ kind: 'requestfailed', observed: observation(), request: started ?? {
      path: pathOnly(request.url()), method: safeText(request.method()), resourceType: safeText(request.resourceType()), started: null,
    }, errorText: safeText(request.failure()?.errorText ?? 'Unknown request failure') });
    pending.delete(request);
  }
  function consoleMessage(message: ConsoleMessage) {
    if (message.type() !== 'error') return;
    counts.consoleErrors++;
    const location = message.location();
    append({ kind: 'console-error', observed: observation(), text: safeText(message.text()), location: { path: pathOnly(location.url), line: location.lineNumber, column: location.columnNumber } });
  }
  page.on('request', request);
  page.on('requestfinished', finished);
  page.on('requestfailed', failed);
  page.on('console', consoleMessage);
  return {
    stage(next: Stage) { if (!disposed) stage = { layout: safeText(next.layout), theme: safeText(next.theme), stage: safeText(next.stage) }; },
    snapshot() {
      return structuredClone({ navigationSequence, current: context(), documents, events, inFlight: [...pending.values()], counts, disposed });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      page.off('request', request);
      page.off('requestfinished', finished);
      page.off('requestfailed', failed);
      page.off('console', consoleMessage);
      pending.clear();
    },
  };
}
