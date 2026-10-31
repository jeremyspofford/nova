// The service definition (M10e; docs/plans/M10-orchestration.md, "The service definition"): one
// format for every driver, validated in plain words. One test per refusal the ADR names, then the
// rest of the shape, the console's own definition, and the promotion tier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONSOLE, consoleDefinition, promotionTier, validate, type DeviceView, type ServiceDefinition } from '../../src/core/index.ts';
import { standIn } from '../support/services.ts';

const DIGEST = `registry.example/runtime@sha256:${'a'.repeat(64)}`;
const good = (extra: Partial<ServiceDefinition> = {}): ServiceDefinition => standIn({ version: '1.0.0', port: 18080, extra });
const problems = (input: unknown, devices?: DeviceView[]) => {
  const v = validate(input, devices ? { devices } : {});
  return v.ok ? [] : v.problems;
};
const DEVICES: DeviceView[] = [
  { id: 'hub', platform: 'linux', roles: ['general-server', 'hub-candidate'] },
  { id: 'mac', platform: 'darwin', roles: ['capture-source'] },
  { id: 'pc', platform: 'win32', roles: ['compute'] },
];

test('a good definition passes, and so does the ADR’s own example shape', () => {
  assert.deepEqual(problems(good()), []);
  const adr = {
    service: 'inference', version: '1.4.2',
    // The ADR's example names `bin/runtime` inside an archive; Nova installs one file, so its command
    // names that file.
    artifact: { image: DIGEST, program: { 'linux-x64': { url: 'https://example.invalid/runtime', sha256: 'b'.repeat(64), command: ['runtime', 'serve'] } } },
    ports: [{ name: 'api', port: 11434 }], health: { http: '/api/version', every_s: 30 }, contract_tests: ['http:/api/tags'], alongside: 'full',
    placement: { mode: 'preferred', roles: ['compute'], needs: { gpu_vram_gb: 8 }, failover: 'any' }, resources: { memory_mb: 4096 },
    state: { volume: 'models', size_gb: 50 }, secrets: [], egress: 'local', os_permissions: [], soak_s: 86_400,
  };
  assert.deepEqual(problems(adr), []);
  assert.deepEqual(problems(adr, DEVICES), []);
});

test('refused: a floating service that has state', () => {
  const p = problems(good({ placement: { mode: 'floating' }, state: { volume: 'data' } }));
  assert.ok(p.some((x) => /floating service can’t have state/.test(x)), p.join('\n'));
  assert.deepEqual(problems(good({ placement: { mode: 'floating' } })), [], 'floating without state is fine');
});

test('refused: an image-only service pinned to a macOS or a Windows device', () => {
  const imageOnly = (device: string) => good({ artifact: { image: DIGEST }, placement: { mode: 'pinned', device } });
  for (const device of ['mac', 'pc']) {
    const p = problems(imageOnly(device), DEVICES);
    assert.ok(p.some((x) => /only as a container image.*containers run only on Linux/.test(x)), `${device}: ${p.join('\n')}`);
  }
  assert.deepEqual(problems(imageOnly('hub'), DEVICES), [], 'on the Linux device it may');
  // With a program for that platform too, it runs there natively.
  const both = good({ artifact: { image: DIGEST, program: good().artifact.program! }, placement: { mode: 'pinned', device: 'mac' } });
  assert.deepEqual(problems(both, DEVICES), []);
});

test('refused: a placement no device’s roles allow', () => {
  const p = problems(good({ placement: { mode: 'preferred', roles: ['storage'] } }), DEVICES);
  assert.ok(p.some((x) => /No device has the roles it asks for \(storage\)/.test(x)), p.join('\n'));
  const pinned = problems(good({ placement: { mode: 'pinned', device: 'mac', roles: ['compute'] } }), DEVICES);
  assert.ok(pinned.some((x) => /mac included/.test(x)), pinned.join('\n'));
  assert.deepEqual(problems(good({ placement: { mode: 'preferred', roles: ['compute'] } }), DEVICES), [], 'the Windows device has compute');
  assert.ok(problems(good({ placement: { mode: 'pinned', device: 'nowhere' } }), DEVICES).some((x) => /no device nowhere/.test(x)));
  // Devices whose roles aren't known yet (before M10f) aren't held against it.
  assert.deepEqual(problems(good({ placement: { mode: 'preferred', roles: ['storage'] } }), [{ id: 'hub', platform: 'linux' }]), []);
});

test('refused: a secret written as a value instead of a secret:// name', () => {
  for (const s of ['hunter2-hunter2', 'sk-ant-0123456789abcdef', 'secret:/missing-slash', 'secret://']) {
    const p = problems(good({ secrets: [s] }));
    assert.ok(p.some((x) => /written as its value, not as a secret:\/\/ name/.test(x)), `${s}: ${p.join('\n')}`);
    if (!s.startsWith('secret:')) assert.ok(!p.join(' ').includes(s), 'the value is never repeated back');
  }
  assert.deepEqual(problems(good({ secrets: ['secret://services/stand-in/token'] })), []);
});

test('the rest of the shape is checked, each in plain words', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...good(), service: 'Bad Name' }, /service is its name/],
    [{ ...good(), version: 'current' }, /supervisor uses that name/],
    [{ ...good(), artifact: {} }, /nothing to run/],
    [{ ...good(), artifact: { image: 'registry.example/runtime:latest' } }, /pinned by its digest/],
    [{ ...good(), artifact: { program: { 'beos-x86': { url: 'file:///x', sha256: 'c'.repeat(64), command: ['x'] } } } }, /isn’t a platform Nova knows/],
    [{ ...good(), artifact: { program: { 'linux-x64': { url: 'file:///x', sha256: 'c'.repeat(64), command: 'bin/x serve' } } } }, /never one shell string/],
    [{ ...good(), artifact: { program: { 'linux-x64': { url: 'file:///opt/x/definition.json', sha256: 'c'.repeat(64), command: ['node', 'definition.json'] } } } }, /must end in the program’s file name/],
    [{ ...good(), artifact: { program: { 'linux-x64': { url: 'ftp://x', sha256: 'short', command: ['x'] } } } }, /file: or https: address/],
    [{ ...good(), artifact: { release: { tag: 'v1', command: ['node', 'x.js'] } } }, /Only Nova’s own console runs from a release tag/],
    [{ ...good(), ports: [{ name: 'api', port: 0 }] }, /port number from 1024 to 65535/],
    [{ ...good(), ports: [{ name: 'api', port: 1 }, { name: 'api', port: 2 }] }, /Two ports are named api/],
    [{ ...good(), health: { http: 'health', every_s: 30 } }, /health is \{http/],
    [{ ...good(), contract_tests: ['probe:runtime-lists-models'] }, /names a probe, and Nova has no named probes/],
    [{ ...good(), contract_tests: ['smoke'] }, /isn’t one Nova can run/],
    [{ ...good(), alongside: 'twice' }, /alongside is how a new version runs/],
    [{ ...good(), placement: { mode: 'pinned' } }, /names its device/],
    [{ ...good(), placement: { mode: 'pinned', device: 'hub', replicas: 2 } }, /Only a floating service has replicas/],
    [{ ...good(), egress: 'anywhere' }, /egress is none, local, internet/],
    [{ ...good(), soak_s: -1 }, /soak_s is a whole number/],
    [{ ...good(), resources: { cpu: 2 } }, /resources is \{memory_mb\}/],
    [{ ...good(), skip_tests: true }, /“skip_tests” isn’t part of a service definition/],
  ];
  for (const [input, want] of cases) {
    const p = problems(input);
    assert.ok(p.some((x) => want.test(x)), `${want}: ${p.join('\n') || 'no problems'}`);
  }
  assert.deepEqual(problems('not json'), ['A service definition is a JSON object.']);
});

test('the console’s own definition is valid: a release tag, its health, a copy of the home alongside', () => {
  const def = consoleDefinition({ version: 'v1.2.0', port: 4317 });
  assert.deepEqual(problems(def), []);
  assert.equal(def.service, CONSOLE);
  assert.deepEqual(def.artifact.release, { tag: 'v1.2.0', command: ['node', 'src/server.js'] });
  assert.equal(def.alongside, 'copy');
  assert.equal(def.health.http, '/api/v1/health');
  // The base (no release current) and a port it chooses are the console's alone.
  assert.deepEqual(problems(consoleDefinition({ version: 'base', port: 0 })), []);
  assert.ok(problems({ ...good(), version: 'base' }).length, 'another service can’t be called base');
});

test('promotion is tier 3 for the console and anything with secrets or OS permissions, tier 2 otherwise', () => {
  assert.equal(promotionTier(consoleDefinition({ version: 'v1', port: 4317 })), 3);
  assert.equal(promotionTier(good({ secrets: ['secret://x'] })), 3);
  assert.equal(promotionTier(good({ os_permissions: ['screen-recording'] })), 3);
  assert.equal(promotionTier(good()), 2);
});

test('the command runs the pinned program and nothing else: never another program, a shell, inline code or a path out of its folder', () => {
  const withCommand = (command: string[]) => good({ artifact: { program: { 'linux-x64': { url: 'file:///opt/stand-in/fake-service.js', sha256: 'c'.repeat(64), command } } } });
  const refused: [string[], RegExp][] = [
    [['../../../../../../usr/bin/env', 'node', '/opt/elsewhere.js'], /starts with "..\/..\/..\/..\/..\/..\/usr\/bin\/env"/],
    [['/usr/bin/env', 'node', 'fake-service.js'], /never another program, a shell, an absolute path/],
    [['sh', '-c', 'node fake-service.js'], /starts with "sh"/],
    [['bash', 'fake-service.js'], /starts with "bash"/],
    [['python3', 'fake-service.js'], /starts with "python3"/],
    [['node', '-e', 'require("child_process").execSync("id")'], /no interpreter option or inline code/],
    [['node', '--eval', 'process.exit(0)'], /no interpreter option or inline code/],
    [['node', '--input-type=module', '-e', 'import("x")'], /no interpreter option or inline code/],
    [['node', '--require', '/tmp/x.js', 'fake-service.js'], /no interpreter option or inline code/],
    [['node', '--import', 'data:text/javascript,1', 'fake-service.js'], /no interpreter option or inline code/],
    [['node', 'other.js'], /the next word must be its own program, fake-service\.js/],
    [['node', '../fake-service.js'], /the next word must be its own program/],
    [['./../fake-service.js'], /never another program/],
  ];
  for (const [command, want] of refused) {
    const p = problems(withCommand(command));
    assert.ok(p.some((x) => want.test(x)), `${JSON.stringify(command)}: ${p.join('\n') || 'accepted'}`);
  }
  for (const command of [['node', 'fake-service.js'], ['node', './fake-service.js', '-e', 'is the program’s own argument'], ['fake-service.js', 'serve'], ['./fake-service.js']]) {
    assert.deepEqual(problems(withCommand(command)), [], JSON.stringify(command));
  }
});

test('ports below 1024 are refused: they need privileges and belong to the system', () => {
  for (const port of [1, 22, 80, 443, 1023]) {
    const p = problems(good({ ports: [{ name: 'api', port }] }));
    assert.ok(p.some((x) => /from 1024 to 65535: lower ones need privileges/.test(x)), `${port}: ${p.join('\n')}`);
  }
  assert.deepEqual(problems(good({ ports: [{ name: 'api', port: 1024 }] })), []);
});
