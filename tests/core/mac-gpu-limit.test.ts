// A Mac's GPU memory limit (owner decision 2026-11-06; docs/plans/model-fit-adr-2026-11-04.md, open
// question 1): the device agent reads `sysctl -n iogpu.wired_limit_mb` and the hub trusts what it
// reports only as a whole number of bytes the machine's memory can hold. A stand-in execFile
// throughout: real sysctl never runs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHardware, gpuWiredLimit, hardwareWords, type ExecFileLike } from '../../src/core/models/hardware.ts';
import { hubHardware } from '../support/models.ts';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

// Answers like execFile: with what sysctl printed, or with an error. Records each call.
function standIn(answer: { stdout?: string; err?: Error }) {
  const calls: { file: string; args: string[]; o: Parameters<ExecFileLike>[2] }[] = [];
  const exec: ExecFileLike = (file, args, o, cb) => { calls.push({ file, args, o }); queueMicrotask(() => cb(answer.err ?? null, answer.err ? '' : answer.stdout ?? '')); };
  return { exec, calls };
}

test('the sysctl reading: a raised limit in bytes; 0 (the macOS default), garbage, an error and a timeout are null', async () => {
  const raised = standIn({ stdout: '57344\n' });
  assert.equal(await gpuWiredLimit('darwin', raised.exec), 57344 * MiB);
  assert.deepEqual(raised.calls.map((c) => [c.file, c.args]), [['/usr/sbin/sysctl', ['-n', 'iogpu.wired_limit_mb']]], 'a fixed path and fixed args');
  assert.ok(raised.calls[0]!.o.timeout <= 2000 && raised.calls[0]!.o.maxBuffer <= 64, 'a short timeout and bounded output');

  assert.equal(await gpuWiredLimit('darwin', standIn({ stdout: '0\n' }).exec), null, '0 is "not raised"');
  for (const junk of ['', 'abc', '-5', '1.5', '12 34', '1e9', '9999999999', 'sysctl: unknown oid']) {
    assert.equal(await gpuWiredLimit('darwin', standIn({ stdout: junk }).exec), null, `garbage: ${JSON.stringify(junk)}`);
  }
  assert.equal(await gpuWiredLimit('darwin', standIn({ err: new Error('spawn /usr/sbin/sysctl ENOENT') }).exec), null, 'an error');
  // Node ends a command past its timeout and answers with an error saying it was killed.
  assert.equal(await gpuWiredLimit('darwin', standIn({ err: Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }), stdout: '57344' }).exec), null, 'a timeout');
});

test('the sysctl reading: off a Mac it is null and nothing runs', async () => {
  for (const os of ['linux', 'win32', 'freebsd']) {
    const s = standIn({ stdout: '57344' });
    assert.equal(await gpuWiredLimit(os, s.exec), null, os);
    assert.equal(s.calls.length, 0, `${os}: sysctl isn't run`);
  }
});

test('the hub boundary: only a positive whole number of bytes no larger than the memory is kept', () => {
  const mac = (v: unknown, extra: Record<string, unknown> = {}) => checkHardware(hubHardware({ platform: 'darwin', ram_bytes: 64 * GiB, gpu_wired_limit_bytes: v, ...extra })).gpu_wired_limit_bytes;
  assert.equal(mac(56 * GiB), 56 * GiB);
  assert.equal(mac(64 * GiB), 64 * GiB, 'the whole memory is allowed');
  assert.equal(mac(-1), null, 'negative');
  assert.equal(mac(0), null, 'zero');
  assert.equal(mac(56 * GiB + 0.5), null, 'not an integer');
  assert.equal(mac(64 * GiB + 1), null, 'more than the memory');
  assert.equal(mac(String(56 * GiB)), null, 'a string');
  assert.equal(mac(Number.NaN), null);
  assert.equal(mac(2 ** 60, { ram_bytes: 2 ** 61 }), null, 'past a safe integer');
  assert.equal(checkHardware(hubHardware({ platform: 'darwin' })).gpu_wired_limit_bytes, null, 'missing: an older agent');
});

test('the hardware line names a unified GPU with the budget it is given', () => {
  const h = checkHardware(hubHardware({ platform: 'darwin', ram_bytes: 64 * GiB, gpus: [{ vendor: 'apple', name: 'Example Apple GPU', vram_bytes: 48 * GiB, vram_free_bytes: null, unified: true }] }));
  assert.match(hardwareWords(h, 56 * GiB), /^Example Apple GPU \(56 GB shared\)/);
  assert.match(hardwareWords(h), /^Example Apple GPU \(48 GB shared\)/, 'without one, the GPU’s own figure');
  assert.match(hardwareWords(checkHardware(hubHardware()), 56 * GiB), /^Example GPU 24GB \(24 GB\)/, 'a card keeps its own memory');
});
