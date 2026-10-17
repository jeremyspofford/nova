// Node identity and capability document (docs/23 §3, ADR-089): signatures verify with the raw
// public key, the canonical form is stable, and the document satisfies the contract schema.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contracts } from '@nova/contracts';
import {
  buildCapability,
  canonicalJson,
  detectGpus,
  detectHardware,
  detectOs,
  generateKeys,
  newDeviceId,
  newJobToken,
  signDocument,
  tokenMatches,
} from '../src/index.ts';

describe('canonical JSON', () => {
  it('sorts keys at every level, keeps array order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' }, e: undefined })).toBe(
      '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}',
    );
    expect(canonicalJson('é"')).toBe('"é\\""');
  });

  it('refuses values JSON cannot carry', () => {
    expect(() => canonicalJson({ n: Infinity })).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
  });
});

describe('keys and tokens', () => {
  it('signs the canonical form so the raw public key verifies it', () => {
    const keys = generateKeys();
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const doc = { z: 1, a: [1, 2] };
    const sig = signDocument(doc, keys.privateKeyPem);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const pub = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: keys.publicKey },
      format: 'jwk',
    });
    const bytes = Buffer.from(canonicalJson({ a: [1, 2], z: 1 }));
    expect(verify(null, bytes, pub, Buffer.from(sig, 'base64url'))).toBe(true);
    expect(verify(null, Buffer.from('{"a":[2,1],"z":1}'), pub, Buffer.from(sig, 'base64url'))).toBe(
      false,
    );
  });

  it('makes random job tokens and device ids and compares tokens exactly', () => {
    const t = newJobToken();
    expect(t).toMatch(/^nvj_[A-Za-z0-9_-]{43}$/);
    expect(newJobToken()).not.toBe(t);
    expect(newDeviceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(tokenMatches(t, t)).toBe(true);
    expect(tokenMatches(t, `${t}x`)).toBe(false);
    expect(tokenMatches('', t)).toBe(false);
  });
});

describe('capability document', () => {
  it('matches contracts/schemas/device-capability.json', () => {
    const doc = buildCapability({
      deviceId: newDeviceId(),
      name: 'desk',
      backendKind: 'llamacpp',
      models: ['b', 'a', 'a'],
      maxConcurrentJobs: 2,
    });
    expect(contracts().validate('device-capability.json', doc)).toEqual({ ok: true, errors: [] });
    expect(doc).toMatchObject({
      schemaVersion: 1,
      roles: ['compute'],
      modules: ['compute'],
      services: { computeBackends: ['llama.cpp'], modelsPresent: [{ id: 'a' }, { id: 'b' }] },
      computePolicy: { maxConcurrentJobs: 2 },
    });
  });

  it('declares detected GPUs and facts', () => {
    const doc = buildCapability({
      deviceId: 'd',
      name: 'gpu box',
      backendKind: 'ollama',
      models: [],
      maxConcurrentJobs: 1,
      hardware: { arch: 'x86_64', cores: 0, ramBytes: 1, gpus: [{ vendor: 'nvidia', name: 'X' }] },
      os: { family: 'linux', version: '6' },
    });
    expect(doc.hardware).toEqual({
      arch: 'x86_64',
      cores: 1,
      ramBytes: 1,
      gpus: [{ vendor: 'nvidia', name: 'X' }],
    });
    expect(contracts().validate('device-capability.json', doc).ok).toBe(true);
    const hw = detectHardware();
    expect(hw.cores).toBeGreaterThan(0);
    expect(detectOs().family).toMatch(/^[a-z_]+$/);
  });

  it('reads NVIDIA GPUs from the driver procfs layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-gpus-'));
    try {
      mkdirSync(join(root, '0000:01:00.0'));
      writeFileSync(
        join(root, '0000:01:00.0', 'information'),
        'Model: \t NVIDIA RTX Test\nIRQ: 1\n',
      );
      mkdirSync(join(root, '0000:02:00.0'));
      writeFileSync(join(root, '0000:02:00.0', 'information'), 'IRQ: 2\n');
      mkdirSync(join(root, '0000:03:00.0'));
      expect(detectGpus(root)).toEqual([
        { vendor: 'nvidia', name: 'NVIDIA RTX Test' },
        { vendor: 'nvidia' },
      ]);
      expect(detectGpus(join(root, 'missing'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
