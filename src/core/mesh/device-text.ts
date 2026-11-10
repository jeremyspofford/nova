// What a paired device says about itself is another machine's words, and that machine may be buggy
// or compromised. Its reports (a heartbeat with its versions, its workloads' `said` for any service,
// its hardware; a problem it reports; why its capture waits) are stored, copied to the standby, put
// into problems and shown on the person's screens. So the hub cleans them where they come in, once,
// whatever field or service they belong to: terminal escape sequences out, control characters (C0,
// DEL, C1, line and paragraph separators) to a space, format characters out (the bidi overrides and
// isolates that make text read backwards, zero-width characters, BOMs) along with lone surrogates,
// and every string bounded. Each handler still applies its own, shorter, limit per field.
//
// An honest device's messages are plain one-line sentences, so they come through unchanged.
// Escaping for HTML is not done here: the screens escape whatever they show.

import { redactShapes } from '../../device/secret-shapes.ts';

// The longest string a device report keeps, in UTF-16 code units. Every field the hub reads from a
// report is shorter (a workload's `said` 300, a problem's detail 300, hardware names 120, versions 80).
export const DEVICE_TEXT_MAX = 1000;
// How deep a report may nest. A heartbeat's deepest member (hardware → network → a card → its
// wake-on-LAN facts) is five down; anything below the limit is dropped (null).
export const DEVICE_REPORT_DEPTH = 8;

// CSI (ESC [ … final, or the 8-bit CSI), OSC (ESC ] … BEL or ST), and the other two-character escapes.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]?|\u009b[0-?]*[ -/]*[@-~]?|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[ -/]*[0-~]?/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const FORMAT = /[\p{Cf}\p{Cs}]/gu;

// One line of a device's text: escapes and format characters out, control characters to a space, at
// most `max` code units (never ending in half a surrogate pair).
export function deviceText(s: string, max = DEVICE_TEXT_MAX): string {
  // A bounded amount of work for any input: the escapes and controls taken out can't shrink more than
  // this down to the limit that matters.
  const t = s.slice(0, max * 8).replace(ANSI, '').replace(CONTROL, ' ').replace(FORMAT, '');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

// A whole report from a device, every string in it cleaned by deviceText, nesting bounded. Numbers,
// booleans and null are kept as they are; the handler checks what each member means.
export function deviceReport(body: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown, depth: number): unknown => {
    // Secret shapes too: a device that predates its own scrubbing (X-001) can't put one in a record.
    if (typeof v === 'string') return redactShapes(deviceText(v));
    if (v === null || typeof v !== 'object') return v;
    if (depth >= DEVICE_REPORT_DEPTH) return null;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1)]));
  };
  return walk(body ?? {}, 0) as Record<string, unknown>;
}
