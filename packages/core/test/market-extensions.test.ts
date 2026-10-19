// Extensions from the marketplace (FR-049, FR-117; ADR-097 D2): a `.novax` item installs through
// the extension installer, so the extension records its own verdict and its publisher. The
// sample catalog's signed `.novax` is a Verified extension once its publisher is trusted (even
// under managed policy that forbids unverified installs); signed by a key nobody trusts, it needs
// the sideload confirmation and stays Unverified with its key recorded; an extension shipped as a
// folder is never Verified; removal goes through the extension installer too.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NovaDatabase } from '@nova/storage';
import { SAMPLE_CATALOG_ID, SAMPLE_CATALOG_PUBLIC_KEY } from '../src/market/index.ts';
import {
  ACCOUNT,
  SAMPLE_CATALOG,
  folderDigest,
  marketEnv,
  openMarketDb,
  writeCatalog,
  testPublisher,
  type MarketEnv,
} from './fixtures/market/env.ts';
import { EXAMPLE_LABS_PUBLIC_KEY } from './fixtures/market/sample-key.ts';

const WORD_COUNT = 'com.examplelabs.word-count';
let dir: string;
let db: NovaDatabase;
let env: MarketEnv;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-market-ext-'));
  db = await openMarketDb();
  env = marketEnv(dir, db, { extensions: true });
  env.catalogs.push({
    id: SAMPLE_CATALOG_ID,
    name: 'Sample catalog',
    location: SAMPLE_CATALOG,
    builtin: true,
    publisherKey: SAMPLE_CATALOG_PUBLIC_KEY,
  });
});
afterEach(async () => {
  env.market.close();
  await env.extensions?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const preview = (id = WORD_COUNT, catalogId = SAMPLE_CATALOG_ID) =>
  env.market.preview(ACCOUNT, { catalogId, kind: 'plugin', id });

describe('the sample catalog’s signed .novax', () => {
  it('installs as a Verified extension with its publisher, even when unverified installs are forbidden', async () => {
    env.trusted.push({ name: 'Example Labs', key: EXAMPLE_LABS_PUBLIC_KEY });
    env.policy.unverified = false;
    const p = await preview();
    expect(p.verification).toEqual({
      status: 'verified',
      reasons: [],
      publisher: { key: EXAMPLE_LABS_PUBLIC_KEY, name: 'Example Labs' },
    });
    expect(p.permissions.map((l) => l.kind)).toEqual(expect.arrayContaining(['command', 'tool']));
    expect(p.details).toMatchObject({ extension: { verified: true, api: 1 } });
    const view = await env.market.install(ACCOUNT, { previewId: p.previewId });
    expect(view).toMatchObject({ verified: true, publisherKey: EXAMPLE_LABS_PUBLIC_KEY });

    expect(await env.extensions!.get(ACCOUNT, WORD_COUNT)).toMatchObject({
      verified: true,
      signature: 'verified',
      publisher: { key: EXAMPLE_LABS_PUBLIC_KEY, name: 'Example Labs', trusted: true },
    });
    expect(await env.plugins.get(ACCOUNT, WORD_COUNT)).toMatchObject({ verified: true });
    expect(env.audit.find((a) => a.action === 'extension.install')).toBeTruthy();
    expect(env.audit.find((a) => a.action === 'plugin.install')?.detail).toMatchObject({
      verified: true,
      publisher: EXAMPLE_LABS_PUBLIC_KEY,
    });
    const listed = (await env.market.search(ACCOUNT)).find((i) => i.id === WORD_COUNT);
    expect(listed).toMatchObject({ installedVersion: '1.0.0', updateAvailable: false });

    // Previewing the same version again compares the extension installer's own lines.
    const again = await preview();
    expect(again.diff).toMatchObject({ added: [], removed: [], changed: [] });

    await env.market.remove(ACCOUNT, 'plugin', WORD_COUNT);
    await expect(env.extensions!.get(ACCOUNT, WORD_COUNT)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(env.plugins.get(ACCOUNT, WORD_COUNT)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('signed by a publisher nobody trusts, needs the sideload confirmation and stays Unverified', async () => {
    const p = await preview();
    expect(p.verification).toMatchObject({
      status: 'unverified',
      reasons: ['bundle_untrusted'],
      publisher: { key: EXAMPLE_LABS_PUBLIC_KEY },
    });
    await expect(env.market.install(ACCOUNT, { previewId: p.previewId })).rejects.toMatchObject({
      details: { reason: 'sideload_confirmation_required' },
    });
    await env.market.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
    expect(await env.extensions!.get(ACCOUNT, WORD_COUNT)).toMatchObject({
      verified: false,
      signature: 'unverified',
      publisher: { key: EXAMPLE_LABS_PUBLIC_KEY, trusted: false },
    });
    expect((await env.market.installed(ACCOUNT))[0]).toMatchObject({ verified: false });
  });
});

it('never verifies an extension shipped as a folder', async () => {
  const root = join(dir, 'cat');
  cpSync(join(SAMPLE_CATALOG, 'src', 'word-count'), join(root, 'word-count'), { recursive: true });
  const key = testPublisher();
  writeCatalog(
    root,
    {
      items: [
        {
          kind: 'plugin',
          id: WORD_COUNT,
          name: 'Word count',
          version: '1.0.0',
          path: 'word-count',
          digest: folderDigest(join(root, 'word-count')),
        },
      ],
    },
    key.privateKey,
  );
  env.catalogs.push({ id: 'cat', name: 'Cat', location: root, publisherKey: key.publicKey });
  const p = await preview(WORD_COUNT, 'cat');
  expect(p.verification.reasons).toEqual(['bundle_unsigned']);
  await env.market.install(ACCOUNT, { previewId: p.previewId, confirmSideload: true });
  expect(await env.extensions!.get(ACCOUNT, WORD_COUNT)).toMatchObject({
    verified: false,
    publisher: { key: null },
  });
});
