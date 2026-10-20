// The checks every area makes against managed policy (FR-106, ADR-097 D4): each restriction with
// its allow and deny forms, the most restrictive of two sources, fail-closed tools, and the one
// refusal shape (`policy_denied` `{reason: managed}`).
import { describe, expect, it } from 'vitest';
import type { ManagedRestrict, ToolDescriptor } from '@nova/shared';
import {
  ManagedRestrictions,
  NO_RESTRICTIONS,
  effectiveEgressAllow,
  extensionOfTool,
  globMatch,
  managedDenied,
  managedRestrictions,
  mcpServerOfTool,
} from '../src/managed/index.ts';

const HOME = '/home/me';
const of = (...layers: ManagedRestrict[]) =>
  new ManagedRestrictions({ layers, failClosed: null }, { home: HOME });

type T = Pick<ToolDescriptor, 'name' | 'source' | 'pluginId' | 'annotations' | 'effects'>;
const tool = (name: string, extra: Partial<T> = {}): T => ({ name, source: 'builtin', ...extra });

describe('helpers', () => {
  it('matches globs, ignoring case and treating other characters literally', () => {
    expect(globMatch('screen.*', 'screen.capture')).toBe(true);
    expect(globMatch('screen.*', 'screenXcapture')).toBe(false);
    expect(globMatch('mcp:CORP-*', 'mcp:corp-docs.search')).toBe(true);
    expect(globMatch('exec.run', 'exec.run')).toBe(true);
    expect(globMatch('exec.run', 'exec.runner')).toBe(false);
    expect(globMatch('a+b', 'a+b')).toBe(true);
  });

  it('reads MCP servers and extensions from tool names', () => {
    expect(mcpServerOfTool('mcp:corp-docs.search')).toBe('corp-docs');
    expect(mcpServerOfTool('exec.run')).toBeNull();
    expect(extensionOfTool('ext:com.acme.notes/add')).toBe('com.acme.notes');
    expect(extensionOfTool('plugin:x.y')).toBeNull();
  });

  it('refuses with policy_denied {reason: managed}', () => {
    const err = managedDenied('nope', { what: 'x', reason: 'ignored' });
    expect(err.code).toBe('policy_denied');
    expect(err.details).toEqual({ what: 'x', reason: 'managed' });
    expect(err.message).toBe('nope');
  });

  it('parses the setting value, failing closed on garbage', () => {
    expect(managedRestrictions(undefined).active).toBe(false);
    expect(managedRestrictions({ layers: [], failClosed: null }).active).toBe(false);
    const bad = managedRestrictions({ layers: 'x' });
    expect(bad.failClosed).toMatch(/unreadable/);
    expect(bad.tool(tool('fs.read'))).toMatch(/could not be read/);
    expect(NO_RESTRICTIONS.active).toBe(false);
    expect(of({}).active).toBe(true);
  });
});

describe('permission modes', () => {
  it('denies listed modes and modes outside an allow list, never Manual', () => {
    const r = of({ permissionModes: { deny: ['bypass', 'manual'] } });
    expect(r.permissionMode('bypass')).toMatch(/Bypass mode is turned off/);
    expect(r.permissionMode('auto')).toBeNull();
    expect(r.permissionMode('manual')).toBeNull();
    const a = of({ permissionModes: { allow: ['plan'] } });
    expect(a.permissionMode('accept_edits')).toMatch(/Accept edits/);
    expect(a.permissionMode('plan')).toBeNull();
    expect(a.permissionMode('manual')).toBeNull();
    expect(of({}).permissionMode('bypass')).toBeNull();
  });

  it('maps approval policies and autonomy to their modes', () => {
    const r = of({ permissionModes: { deny: ['bypass', 'auto'] } });
    expect(r.approvalPolicy('never_ask')).toMatch(/Bypass/);
    expect(r.approvalPolicy('review')).toMatch(/Auto/);
    expect(r.approvalPolicy('defaults')).toBeNull();
    expect(r.clampApproval('never_ask')).toBe('ask_always');
    expect(r.clampApproval('review')).toBe('ask_always');
    expect(r.clampApproval('defaults')).toBe('defaults');
    expect(r.autonomy('autonomous')).toMatch(/Autonomous work/);
    expect(r.autonomy('standard')).toBeNull();
    expect(of({ permissionModes: { deny: ['bypass'] } }).autonomy('autonomous')).toBeNull();
  });
});

describe('tools', () => {
  it('fails closed when the policy could not be read', () => {
    const r = new ManagedRestrictions({ layers: [], failClosed: 'bad json' });
    expect(r.active).toBe(true);
    expect(r.tool(tool('fs.read'))).toMatch(/could not be read \(bad json\)/);
  });

  it('applies deny and allow lists', () => {
    const r = of({ tools: { deny: ['screen.*'] } }, { tools: { allow: ['fs.*', 'screen.*'] } });
    expect(r.tool(tool('screen.capture'))).toMatch(/is not allowed/);
    expect(r.tool(tool('exec.run'))).toMatch(/not among the tools allowed/);
    expect(r.tool(tool('fs.read'))).toBeNull();
  });

  it("checks a tool's MCP server, plugin and extension", () => {
    const r = of({
      mcpServers: { deny: ['shell-*'] },
      plugins: { allow: ['com.corp.*'] },
      extensions: { deny: ['com.bad.*'] },
    });
    expect(r.tool(tool('mcp:shell-anything.run', { source: 'mcp' }))).toMatch(/MCP server/);
    expect(r.tool(tool('mcp:docs.search', { source: 'mcp' }))).toBeNull();
    expect(r.tool(tool('plugin:x.y', { source: 'plugin', pluginId: 'org.other.x' }))).toMatch(
      /The plugin org.other.x/,
    );
    expect(r.tool(tool('plugin:x.y', { source: 'plugin', pluginId: 'com.corp.x' }))).toBeNull();
    expect(r.tool(tool('ext:com.bad.thing/run', { source: 'plugin' }))).toMatch(/extension/);
    expect(r.tool(tool('ext:com.good.thing/run', { source: 'plugin' }))).toBeNull();
  });

  it('checks the site of a browser tool and network tools while egress is off', () => {
    const r = of({ browserDomains: { deny: ['*.bank.example'] }, egress: { mode: 'off' } });
    expect(r.tool(tool('browser.navigate'), 'www.bank.example')).toMatch(/not a site/);
    expect(r.tool(tool('fs.read'), 'www.bank.example')).toBeNull();
    expect(r.tool(tool('web.fetch', { annotations: { requiresNetwork: true } }))).toMatch(
      /network access is turned off/,
    );
    expect(r.tool(tool('x.send', { effects: ['network'] }))).toMatch(/network/);
    expect(r.tool(tool('fs.read', { effects: ['file_write'] }))).toBeNull();
    expect(of({ egress: { mode: 'limited' } }).egressOff()).toBe(false);
  });
});

describe('plugins, extensions and MCP servers', () => {
  it('denies by id lists', () => {
    const r = of({ plugins: { deny: ['com.bad.*'] }, extensions: { allow: ['com.corp.*'] } });
    expect(r.plugin('com.bad.x')).toMatch(/not allowed/);
    expect(r.plugin('com.good.x')).toBeNull();
    expect(r.extension('com.other.x')).toMatch(/The extension/);
    expect(r.extension('com.corp.x')).toBeNull();
  });

  it('counts imported and bundled servers as added by the user, and network servers under egress off', () => {
    const r = of({ mcpServers: { userAdded: false } });
    for (const source of ['user', 'import', 'bundle'])
      expect(r.mcpServer({ name: 'x', source, transport: 'stdio' }), source).toMatch(/yourself/);
    expect(r.mcpServer({ name: 'x', source: 'plugin', transport: 'stdio' })).toBeNull();
    const off = of({ egress: { mode: 'off' } });
    expect(off.mcpServer({ name: 'x', source: 'plugin', transport: 'http' })).toMatch(/network/);
    expect(off.mcpServer({ name: 'x', source: 'plugin', transport: 'stdio' })).toBeNull();
    expect(off.tool(tool('mcp:docs.search', { source: 'mcp' }), null, { remote: true })).toMatch(
      /network access/,
    );
    expect(off.tool(tool('mcp:docs.search', { source: 'mcp' }))).toBeNull();
  });

  it('refuses servers by name, user-added servers and local stdio servers', () => {
    const r = of({ mcpServers: { allow: ['corp-*'], userAdded: false, localStdio: false } });
    expect(r.mcpServer({ name: 'other', source: 'bundle', transport: 'http' })).toMatch(
      /The MCP server other/,
    );
    expect(r.mcpServer({ name: 'corp-a', source: 'user', transport: 'http' })).toMatch(
      /you add yourself/,
    );
    expect(r.mcpServer({ name: 'corp-a', source: 'plugin', transport: 'stdio' })).toMatch(
      /run on the Hub/,
    );
    expect(
      r.mcpServer({ name: 'corp-a', source: 'plugin', transport: 'stdio', deviceId: 'd1' }),
    ).toBeNull();
    expect(r.mcpServer({ name: 'corp-a', source: 'plugin', transport: 'http' })).toBeNull();
    expect(of({}).mcpServer({ name: 'x', source: 'user', transport: 'stdio' })).toBeNull();
  });
});

describe('the egress ceiling', () => {
  it('works out the hosts in force from the owner list, and refuses hosts outside it', () => {
    expect(effectiveEgressAllow([], ['a.example'])).toEqual(['a.example']);
    expect(effectiveEgressAllow([['api.example.com']], [])).toEqual(['api.example.com']);
    expect(effectiveEgressAllow([['*.example.com']], ['a.example', 'api.example.com'])).toEqual([
      'api.example.com',
    ]);
    expect(effectiveEgressAllow([['api.example.com']], ['a.example'])).toEqual([]);
    // Two sources: the first one's hosts that the second covers.
    expect(effectiveEgressAllow([['api.example.com', 'b.example'], ['*.example.com']], [])).toEqual(
      ['api.example.com'],
    );
    const r = of({ egress: { allow: ['*.corp.example'] } });
    expect(r.egressCeilings()).toEqual([['*.corp.example']]);
    expect(r.egressCovered('api.corp.example')).toBe(true);
    expect(r.egressCovered('evil.example')).toBe(false);
    expect(r.egressAllow([])).toEqual(['*.corp.example']);
    // A worked-out list the policy sent wins over working it out again.
    expect(
      new ManagedRestrictions({
        layers: [],
        failClosed: null,
        egressAllow: ['x.example'],
      }).egressAllow(['y.example']),
    ).toEqual(['x.example']);
    const fetch = tool('web.fetch', { annotations: { requiresNetwork: true } });
    expect(r.tool(fetch, 'evil.example')).toMatch(/not among the hosts/);
    expect(r.tool(fetch, 'API.corp.example')).toBeNull();
    expect(r.tool(tool('fs.read'), 'evil.example')).toBeNull();
    expect(of({}).tool(fetch, 'evil.example')).toBeNull();
  });
});

describe('narrowing roots to the allowed folders', () => {
  it("narrows every root, a profile's own entries included, and keeps the workspace", () => {
    const r = of({ folders: { allow: ['~/src', '/work'], deny: ['~/src/secret'] } });
    const out = r.narrowRoots(
      [
        { path: '/', access: 'write' },
        { path: '/home/me', access: 'read', label: 'Home' },
        { path: '/home/me/src/app', access: 'write', label: 'app' },
        { path: '/home/me/src/secret/x', access: 'write' },
        { path: '/data/workspace', access: 'write', label: 'Workspace' },
        { path: '/etc', access: 'read' },
      ],
      { exempt: ['/data/workspace'] },
    );
    expect(out.roots).toEqual([
      { path: '/home/me/src', access: 'write', label: 'src' },
      { path: '/work', access: 'write', label: 'work' },
      { path: '/home/me/src/app', access: 'write', label: 'app' },
      { path: '/data/workspace', access: 'write', label: 'Workspace' },
    ]);
    expect(out.deny).toEqual(['/home/me/src/secret']);
    // Each source narrows in turn; the canonical form maps the policy's paths.
    const two = of({ folders: { allow: ['/a'] } }, { folders: { allow: ['/a/b', '/c'] } });
    expect(two.narrowRoots([{ path: '/', access: 'read' }]).roots).toEqual([
      { path: '/a/b', access: 'read', label: 'b' },
    ]);
    expect(
      of({ folders: { allow: ['/real'] } }).narrowRoots([{ path: '/', access: 'read' }], {
        canonical: (p) => p.replace('/real', '/resolved'),
      }).roots,
    ).toEqual([{ path: '/resolved', access: 'read', label: 'resolved' }]);
    expect(of({}).narrowRoots([{ path: '/x', access: 'read' }])).toEqual({
      roots: [{ path: '/x', access: 'read', label: '/x' }],
      deny: [],
    });
  });
});

describe('sessions and folders', () => {
  it('refuses local sessions and SSH sessions or hosts', () => {
    expect(of({ sessions: { local: false } }).localSessions()).toMatch(/this machine/);
    expect(of({ sessions: { local: true } }).localSessions()).toBeNull();
    expect(of({ sessions: { ssh: false } }).sshHost('a.example')).toMatch(/SSH sessions are/);
    const hosts = of({ sessions: { sshHosts: ['*.build.corp.example'] } }, {});
    expect(hosts.sshHost('X.build.corp.example')).toBeNull();
    expect(hosts.sshHost('evil.example')).toMatch(/to evil.example/);
    expect(of({}).sshHost('a')).toBeNull();
  });

  it('checks folders against allow and deny lists, with ~ as the home folder', () => {
    const r = of({ folders: { allow: ['~/src', '/work'], deny: ['~/src/secret'] } });
    expect(r.restrictsFolders).toBe(true);
    expect(r.folder('/home/me/src/app')).toBeNull();
    expect(r.folder('/work')).toBeNull();
    expect(r.folder('/home/me/src/secret/x')).toMatch(/not allowed/);
    expect(r.folder('/home/me/other')).toMatch(/outside the folders/);
    expect(of({ folders: { allow: ['~'] } }).folder('/home/me/x')).toBeNull();
    expect(of({}).folder('/anything')).toBeNull();
    expect(of({}).restrictsFolders).toBe(false);
  });
});

describe('browser, egress, telemetry, routing, installs and apps', () => {
  it('checks browser domains', () => {
    const r = of({ browserDomains: { allow: ['*.corp.example'], deny: ['hr.corp.example'] } });
    expect(r.browserDomain('wiki.corp.example.')).toBeNull();
    expect(r.browserDomain('hr.corp.example')).toMatch(/not a site/);
    expect(r.browserDomain('example.org')).toMatch(/not a site/);
    expect(r.browserDeny()).toEqual(['hr.corp.example']);
    expect(r.browserAllows('wiki.corp.example')).toBe(true);
    expect(r.browserAllows('*.corp.example')).toBe(true);
    expect(r.browserAllows('example.org')).toBe(false);
    expect(of({}).browserAllows('example.org')).toBe(true);
  });

  it('turns off telemetry export, unverified installs and apps', () => {
    const r = of({ telemetryExport: false, unverifiedInstalls: false, apps: false });
    expect(r.telemetryExport()).toMatch(/Telemetry export/);
    expect(r.unverifiedInstall()).toMatch(/unverified plugin/);
    expect(r.unverifiedInstall('an unsigned bundle')).toMatch(/unsigned bundle/);
    expect(r.apps()).toMatch(/Authorizing apps/);
    const open = of({ telemetryExport: true, unverifiedInstalls: true, apps: true });
    expect(open.telemetryExport()).toBeNull();
    expect(open.unverifiedInstall()).toBeNull();
    expect(open.apps()).toBeNull();
  });

  it('intersects provider lists across sources', () => {
    expect(of({}).providers()).toBeNull();
    expect(of({}).provider('openai')).toBeNull();
    const r = of(
      { routing: { providers: ['ollama', 'node', 'openai'] } },
      { routing: { allowCloud: false } },
      { routing: { providers: ['ollama', 'node'] } },
    );
    expect(r.providers()).toEqual(['ollama', 'node']);
    expect(r.provider('openai')).toMatch(/openai providers/);
    expect(r.provider('node')).toBeNull();
  });
});
