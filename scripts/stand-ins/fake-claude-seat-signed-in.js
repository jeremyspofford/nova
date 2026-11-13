#!/usr/bin/env node
// fake-claude-seat.js, but a seat with no sign-in file answers as signed in. For test servers that
// aren't about the seat (tests/acceptance/support.ts): their seat works with nothing written into a
// home before Nova claims it (home-mark.ts refuses a new home that already has seats/ in it).
globalThis.FAKE_CLAUDE_SIGNED_IN = true;
await import('./fake-claude-seat.js');
