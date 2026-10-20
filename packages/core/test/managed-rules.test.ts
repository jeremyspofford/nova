// Which way security settings tighten under managed policy (FR-106, ADR-097 D4): the rule table,
// "looser" and the meet for every rule kind, the values a policy may not set (looser than the
// default, or with no known direction) and the value a key takes against the user's.
import { describe, expect, it } from 'vitest';
import { SETTINGS } from '@nova/shared';
import {
  SECURITY_RULES,
  comparable,
  looser,
  meet,
  ruleFor,
  securityValueProblem,
  tightenSetting,
  type TightenRule,
} from '../src/managed/index.ts';

const OFF: TightenRule = { kind: 'bool', tight: false };
const ORDER: TightenRule = { kind: 'order', order: ['off', 'limited', 'allowlist'] };
const FIELDS: TightenRule = {
  kind: 'fields',
  fields: { n: { kind: 'min' }, floor: { kind: 'max' }, on: OFF },
};

describe('rule table', () => {
  it('names only security settings, each with a rule', () => {
    for (const key of Object.keys(SECURITY_RULES)) {
      const def = (SETTINGS as Record<string, { security?: boolean }>)[key];
      expect(def, key).toBeDefined();
      expect(def?.security, key).toBe(true);
    }
    expect(ruleFor('code.allowBypass')).toEqual(OFF);
    expect(ruleFor('relay.url')).toBeNull();
    expect(ruleFor('toString')).toBeNull();
  });

  it('decides every security setting: a rule, or listed as having no safe direction', () => {
    // Addresses, paths, tokens and similar values have no order, so a policy cannot set them
    // (securityValueProblem: unordered). A new security setting must land in one of the two.
    const UNORDERED = new Set([
      'search.searxngUrl',
      'instructions.files',
      'code.autoVerify',
      'channels.publicUrl',
      'screen.tierOverrides',
      'computers.agentComputer',
      'computers.microVm',
      'sites.publishRoot',
      'browser.executablePath',
      'devices.minNovadVersions',
      'network.lan.mdnsName',
      'network.directPublic.url',
      'network.wakeHelpers',
      'trust.mode',
      'trust.meshCerts',
      'relay.url',
      'relay.selfHosted',
      'push.webPushHosts',
      'relay.registrationTokenRef',
      'cloud.runner.url',
      'cloud.runner.token',
      'cloud.runner.caps',
      'devices.boot.watchdogSeconds',
      'devices.firmware.watchdogSeconds',
      'telemetry.otlp.endpoint',
      'telemetry.otlp.headers',
      'managed.restrict',
    ]);
    const undecided = Object.entries(SETTINGS as Record<string, { security?: boolean }>)
      .filter(([k, d]) => d.security && !Object.hasOwn(SECURITY_RULES, k) && !UNORDERED.has(k))
      .map(([k]) => k);
    expect(undecided).toEqual([]);
    for (const k of UNORDERED) expect(ruleFor(k), k).toBeNull();
    expect(securityValueProblem('relay.url', 'https://relay.example')?.reason).toBe('unordered');
  });
});

describe('comparable', () => {
  it('checks each kind', () => {
    expect(comparable(OFF, true)).toBe(true);
    expect(comparable(OFF, 'yes')).toBe(false);
    expect(comparable(ORDER, 'off')).toBe(true);
    expect(comparable(ORDER, 'custom')).toBe(false);
    expect(comparable({ kind: 'min' }, 3)).toBe(true);
    expect(comparable({ kind: 'max' }, Number.NaN)).toBe(false);
    expect(comparable({ kind: 'allow' }, [])).toBe(true);
    expect(comparable({ kind: 'deny' }, 'x')).toBe(false);
    expect(comparable({ kind: 'roots' }, [])).toBe(true);
    expect(comparable(FIELDS, { n: 1, on: false })).toBe(true);
    expect(comparable(FIELDS, { n: 'x' })).toBe(false);
    expect(comparable(FIELDS, [1])).toBe(false);
  });
});

describe('looser', () => {
  it('compares switches, orders and numbers', () => {
    expect(looser(OFF, true, false)).toBe(true);
    expect(looser(OFF, false, true)).toBe(false);
    expect(looser(OFF, true, true)).toBe(false);
    expect(looser({ kind: 'bool', tight: true }, false, true)).toBe(true);
    expect(looser(ORDER, 'allowlist', 'off')).toBe(true);
    expect(looser(ORDER, 'off', 'allowlist')).toBe(false);
    expect(looser(ORDER, 'custom', 'off')).toBe(false);
    expect(looser({ kind: 'min' }, 10, 5)).toBe(true);
    expect(looser({ kind: 'min' }, 5, 10)).toBe(false);
    expect(looser({ kind: 'min' }, 'x', 10)).toBe(false);
    expect(looser({ kind: 'max' }, 5, 10)).toBe(true);
    expect(looser({ kind: 'max' }, 10, 5)).toBe(false);
    expect(looser({ kind: 'max' }, 10, null)).toBe(false);
  });

  it('never calls a list looser: lists are combined', () => {
    expect(looser({ kind: 'allow' }, ['a', 'b'], [])).toBe(false);
    expect(looser({ kind: 'deny' }, [], ['a'])).toBe(false);
    expect(looser({ kind: 'roots' }, [{ path: '/' }], [])).toBe(false);
  });

  it('calls an object looser when one field is', () => {
    expect(looser(FIELDS, { n: 9, floor: 5 }, { n: 3, floor: 5 })).toBe(true);
    expect(looser(FIELDS, { n: 1, floor: 1 }, { n: 3, floor: 5 })).toBe(true);
    expect(looser(FIELDS, { n: 1, floor: 9, on: false }, { n: 3, floor: 5, on: true })).toBe(false);
    expect(looser(FIELDS, { n: 9 }, { floor: 5 })).toBe(false);
    expect(looser(FIELDS, 'x', { n: 1 })).toBe(false);
  });
});

describe('meet', () => {
  it('takes the tighter switch, enum value and number', () => {
    expect(meet(OFF, true, false)).toBe(false);
    expect(meet(OFF, false, true)).toBe(false);
    expect(meet(OFF, true, true)).toBe(true);
    expect(meet(ORDER, 'limited', 'off')).toBe('off');
    expect(meet(ORDER, 'limited', 'allowlist')).toBe('limited');
    // A user value with no place in the order: the policy's value.
    expect(meet(ORDER, 'limited', 'custom')).toBe('limited');
    expect(meet({ kind: 'min' }, 10, 5)).toBe(5);
    expect(meet({ kind: 'min' }, 10, 'x')).toBe(10);
    expect(meet({ kind: 'max' }, 10, 50)).toBe(50);
    expect(meet({ kind: 'max' }, 10, null)).toBe(10);
  });

  it('intersects allow lists, merges deny lists and narrows roots', () => {
    expect(meet({ kind: 'allow' }, ['a', 'b'], ['b', 'c'])).toEqual(['b']);
    expect(meet({ kind: 'allow' }, ['a'], 'x')).toEqual(['a']);
    expect(meet({ kind: 'deny' }, ['a'], ['a', 'b'])).toEqual(['a', 'b']);
    expect(meet({ kind: 'deny' }, ['a'], null)).toEqual(['a']);
    expect(
      meet(
        { kind: 'roots' },
        [{ path: '/w', access: 'write' }, { path: '/r', access: 'write' }, { path: '/x' }, 'bad'],
        [
          { path: '/w', access: 'write' },
          { path: '/r', access: 'read' },
        ],
      ),
    ).toEqual([
      { path: '/w', access: 'write' },
      { path: '/r', access: 'read' },
    ]);
    expect(meet({ kind: 'roots' }, [{ path: '/w' }], 'x')).toEqual([{ path: '/w' }]);
  });

  it('meets objects field by field and keeps other fields from the policy', () => {
    expect(
      meet(FIELDS, { n: 9, floor: 1, on: true, other: 'p' }, { n: 3, floor: 5, on: false }),
    ).toEqual({ n: 3, floor: 5, on: false, other: 'p' });
    expect(meet(FIELDS, { n: 9 }, 'x')).toEqual({ n: 9 });
  });
});

describe('the marketplace settings', () => {
  const a = 'A'.repeat(43);
  const b = 'B'.repeat(43);
  const sha = 'a'.repeat(40);
  const cat = (extra: object = {}) => ({ id: 'corp', name: 'Corp', location: '/c', ...extra });

  it('only turns sideloads off and only removes kinds', () => {
    expect(securityValueProblem('market.allowSideload', true)).toBeNull();
    expect(tightenSetting('market.allowSideload', true, false)).toBe(false);
    expect(securityValueProblem('market.allowSideload', false)).toBeNull();
    expect(securityValueProblem('market.allowedKinds', ['plugin', 'theme'])).toBeNull();
    expect(tightenSetting('market.allowedKinds', ['plugin', 'theme'], ['theme', 'skill'])).toEqual([
      'theme',
    ]);
    expect(tightenSetting('market.allowedKinds', ['plugin'], undefined)).toEqual(['plugin']);
  });

  it('intersects catalogs by id and location, keeping every pin and dropping a conflict', () => {
    const rule = ruleFor('plugins.catalogs')!;
    expect(comparable(rule, [])).toBe(true);
    expect(looser(rule, [cat()], [])).toBe(false);
    expect(meet(rule, [cat()], [cat({ publisherKey: a, commit: sha })])).toEqual([
      cat({ publisherKey: a, commit: sha }),
    ]);
    expect(meet(rule, [cat({ publisherKey: a })], [cat()])).toEqual([cat({ publisherKey: a })]);
    expect(meet(rule, [cat({ publisherKey: a })], [cat({ publisherKey: a })])).toEqual([
      cat({ publisherKey: a }),
    ]);
    expect(meet(rule, [cat({ publisherKey: a })], [cat({ publisherKey: b })])).toEqual([]);
    expect(meet(rule, [cat(), 'x'], [cat({ location: '/elsewhere' })])).toEqual([]);
    expect(meet(rule, [cat()], 'x')).toEqual([cat()]);
    expect(tightenSetting('plugins.catalogs', [cat({ commit: sha })], [cat()])).toEqual([
      cat({ commit: sha }),
    ]);
  });
});

describe('data controls, extensions, publishers and the reviewer', () => {
  it('turns crash reports and extensions off only', () => {
    expect(securityValueProblem('privacy.crashReports', true)?.reason).toBe('loosens');
    expect(tightenSetting('privacy.crashReports', false, true)).toBe(false);
    expect(tightenSetting('sdk.enabled', false, true)).toBe(false);
    expect(securityValueProblem('sdk.enabled', true)).toBeNull();
  });

  it('caps retention days, null being "keep forever"', () => {
    const cap = ruleFor('retention.threadsDays')!;
    expect(comparable(cap, null)).toBe(true);
    expect(comparable(cap, 'x')).toBe(false);
    expect(looser(cap, null, 30)).toBe(true);
    expect(looser(cap, 60, 30)).toBe(true);
    expect(looser(cap, 30, null)).toBe(false);
    expect(looser(cap, 'x', 30)).toBe(false);
    expect(securityValueProblem('retention.threadsDays', 90)).toBeNull();
    expect(tightenSetting('retention.threadsDays', 90, null)).toBe(90);
    expect(tightenSetting('retention.threadsDays', 90, 30)).toBe(30);
    expect(tightenSetting('retention.runsDays', null, 30)).toBe(30);
    expect(meet(cap, null, undefined)).toBeNull();
    expect(meet(cap, 5, 'x')).toBe(5);
    // The audit floor still holds: a cap below 365 fails the key's schema on load.
    expect(tightenSetting('retention.auditDays', 400, 3650)).toBe(400);
  });

  it('intersects trusted publishers by key and pins the reviewer model', () => {
    const pub = ruleFor('plugins.trustedPublishers')!;
    const a = { name: 'A', key: 'A'.repeat(43) };
    const b = { name: 'B', key: 'B'.repeat(43) };
    expect(comparable(pub, [a])).toBe(true);
    expect(looser(pub, [a, b], [])).toBe(false);
    expect(meet(pub, [a, b], [{ name: 'renamed', key: b.key }, 'x'])).toEqual([b]);
    expect(meet(pub, [a], null)).toEqual([a]);
    const pin = ruleFor('review.model')!;
    expect(comparable(pin, 'acct/model')).toBe(true);
    expect(comparable(pin, { model: 'x' })).toBe(false);
    expect(looser(pin, 'x', null)).toBe(false);
    expect(tightenSetting('review.model', 'acct/judge', 'acct/other')).toBe('acct/judge');
    expect(tightenSetting('review.model', null, 'acct/other')).toBeNull();
  });
});

describe('app registration, the crash report address and the member purge', () => {
  it('only turns open registration off', () => {
    expect(securityValueProblem('apps.openRegistration', false)).toBeNull();
    expect(tightenSetting('apps.openRegistration', false, true)).toBe(false);
    // True is the default: it locks whatever the user chose, never turns it back on.
    expect(securityValueProblem('apps.openRegistration', true)).toBeNull();
    expect(tightenSetting('apps.openRegistration', true, false)).toBe(false);
  });

  it('pins the crash report address and the purge days', () => {
    expect(securityValueProblem('privacy.crashReportEndpoint', '')).toBeNull();
    expect(tightenSetting('privacy.crashReportEndpoint', '', 'https://mine.example/c')).toBe('');
    expect(
      tightenSetting(
        'privacy.crashReportEndpoint',
        'https://corp.example/c',
        'https://mine.example/c',
      ),
    ).toBe('https://corp.example/c');
    expect(securityValueProblem('team.removedMemberPurgeDays', 7)).toBeNull();
    expect(tightenSetting('team.removedMemberPurgeDays', 7, 90)).toBe(7);
    expect(tightenSetting('team.removedMemberPurgeDays', 0, 30)).toBe(0);
    expect(comparable(ruleFor('team.removedMemberPurgeDays')!, Number.NaN)).toBe(false);
  });
});

describe('securityValueProblem', () => {
  it('refuses a key with no known direction or a value outside its order', () => {
    expect(securityValueProblem('relay.url', 'wss://x')?.reason).toBe('unordered');
    expect(securityValueProblem('tools.permissionProfile', 'custom')?.reason).toBe('unordered');
  });

  it('refuses a value looser than the default', () => {
    expect(securityValueProblem('code.allowBypass', true)?.reason).toBe('loosens');
    expect(securityValueProblem('triggers.ratePerHour', 100)?.reason).toBe('loosens');
    expect(securityValueProblem('channels.privateToShared', 'allow')?.reason).toBe('loosens');
  });

  it('accepts a value no looser than the default', () => {
    expect(securityValueProblem('code.allowBypass', false)).toBeNull();
    expect(securityValueProblem('network.egressMode', 'off')).toBeNull();
    expect(securityValueProblem('network.egressAllow', ['a.example'])).toBeNull();
    expect(securityValueProblem('routing.allowCloud', true)).toBeNull();
  });
});

describe('tightenSetting', () => {
  it('meets the policy value with the user value, the default when there is none', () => {
    expect(tightenSetting('network.egressMode', 'limited', undefined)).toBe('limited');
    expect(tightenSetting('network.egressMode', 'limited', 'off')).toBe('off');
    expect(tightenSetting('network.egressMode', 'limited', 'bogus')).toBe('limited');
    expect(
      tightenSetting('network.egressAllow', ['a.example', 'b.example'], ['b.example']),
    ).toEqual(['b.example']);
    expect(tightenSetting('routing.allowCloud', true, false)).toBe(false);
  });

  it("keeps the policy's value when the meet breaks the key's schema", () => {
    const managed = Array.from({ length: 400 }, (_, i) => `m${i}.example`);
    const user = Array.from({ length: 400 }, (_, i) => `u${i}.example`);
    expect(tightenSetting('network.egressDeny', managed, user)).toEqual(managed);
  });

  it('passes other keys through', () => {
    expect(tightenSetting('appearance.theme', 'dark', 'light')).toBe('dark');
    expect(tightenSetting('relay.url', 'x', 'y')).toBe('x');
  });
});
