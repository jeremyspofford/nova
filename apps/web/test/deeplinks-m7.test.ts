// Decision-7 deep links (docs/13 §5, FR-111): `nova://run/<id>`, `nova://code/<id>` and
// `nova://approval/<id>` (and `web+nova://`) open the run, the Code session and the approval (which
// the app shows in its thread, or on the approvals page when it has none). Bad ids are refused.
import { describe, expect, it } from 'vitest';
import { deepLinkPath } from '../src/deeplinks.ts';

describe('M7 deep links (decision 7)', () => {
  it.each([
    ['nova://run/r1', '/work/r1'],
    ['nova://run', '/work'],
    ['nova://work/r1', '/work/r1'],
    [
      'web+nova://run/0199a6c2-7d3e-7f00-9f2b-3c4d5e6f7a8b',
      '/work/0199a6c2-7d3e-7f00-9f2b-3c4d5e6f7a8b',
    ],
    ['nova://code/s1', '/code/s1'],
    ['nova://approval/a1', '/approvals/a1'],
    ['nova://approvals', '/approvals'],
    ['nova:approval/a1', '/approvals/a1'],
    ['NOVA://approval/a1/', '/approvals/a1'],
  ])('%s opens %s', (link, path) => {
    expect(deepLinkPath(link)).toBe(path);
  });

  it.each([
    'nova://run/bad%20id',
    'nova://approval/a1/extra',
    'nova://approval/..%2f..%2fsettings',
    `nova://run/${'x'.repeat(101)}`,
    'https://hub/work/r1',
  ])('refuses %s', (link) => {
    expect(deepLinkPath(link)).toBeNull();
  });
});
