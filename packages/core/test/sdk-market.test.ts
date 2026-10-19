// Extensions through the marketplace (FR-049, FR-117; ADR-097 D2): the plugin row records the
// catalog as the source and the marketplace's origin while the verdict stays the extension
// installer's; an update that fails after it committed rolls back to the previous signed bundle,
// which comes back Verified with its publisher.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import {
  folderBundleFiles,
  generatePublisherKeyPair,
  loadPublisherPrivateKey,
  packBundle,
} from '../src/index.ts';
import {
  ACCOUNT,
  marketEnv,
  openMarketDb,
  testPublisher,
  writeCatalog,
  type MarketEnv,
} from './fixtures/market/env.ts';
import { HELLO_DIR, HELLO_ID } from './sdk-env.ts';

let dir: string;
let db: NovaDatabase;
let env: MarketEnv;
const author = generatePublisherKeyPair();
const catalogKey = testPublisher();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-sdk-market-'));
  db = await openMarketDb();
  env = marketEnv(dir, db, { extensions: true });
  env.trusted.push({ name: 'Nova examples', key: author.publicKey });
  env.catalogs.push({
    id: 'cat',
    name: 'Cat',
    location: join(dir, 'cat'),
    publisherKey: catalogKey.publicKey,
  });
});
afterEach(async () => {
  env.market.close();
  await env.extensions?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Publish a version of the sample extension in the catalog as a signed `.novax`. */
function publish(version: string): void {
  const src = join(dir, `src-${version}`);
  cpSync(HELLO_DIR, src, { recursive: true });
  const pj = join(src, '.nova-plugin', 'plugin.json');
  writeFileSync(pj, readFileSync(pj, 'utf8').replace('"1.0.0"', `"${version}"`));
  const bytes = packBundle(folderBundleFiles(src), {
    privateKey: loadPublisherPrivateKey(author.privateKeyPem),
  }).bytes;
  const file = `hello-${version}.novax`;
  const root = join(dir, 'cat');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, file), bytes);
  writeCatalog(
    root,
    {
      items: [
        {
          kind: 'plugin',
          id: HELLO_ID,
          name: 'Hello extension',
          version,
          path: file,
          publisher: { name: 'Nova examples', key: author.publicKey },
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    },
    catalogKey.privateKey,
  );
}

async function marketInstall() {
  const p = await env.market.preview(ACCOUNT, { catalogId: 'cat', kind: 'plugin', id: HELLO_ID });
  return env.market.install(ACCOUNT, {
    previewId: p.previewId,
    ...(p.diff ? { acceptPermissions: p.diff.hash } : {}),
  });
}

const pluginRow = () =>
  db.raw
    .prepare('SELECT source, origin, signature, version FROM plugin_install WHERE plugin_id = ?')
    .get(HELLO_ID) as { source: string; origin: string; signature: string; version: string };

describe('extensions from the marketplace', () => {
  it('records the catalog as the source with the marketplace origin', async () => {
    publish('1.0.0');
    await marketInstall();
    expect(pluginRow()).toEqual({
      source: 'catalog',
      origin: `cat/${HELLO_ID}@1.0.0`,
      signature: 'verified',
      version: '1.0.0',
    });
    expect(await env.extensions!.get(ACCOUNT, HELLO_ID)).toMatchObject({
      verified: true,
      publisher: { key: author.publicKey, trusted: true },
    });
    expect(env.audit.find((a) => a.action === 'plugin.install')?.detail).toMatchObject({
      source: 'catalog',
      via: 'cat',
      verified: true,
    });
  });

  it('rolls a failed update back to the previous signed bundle, still Verified', async () => {
    publish('1.0.0');
    await marketInstall();
    publish('1.1.0');
    const real = env.installers.plugin;
    const install = real.install.bind(real);
    // The extension installer commits the update, then the next step fails.
    real.install = async (req) => {
      await install(req);
      throw new NovaError('server_error', 'disk full');
    };
    await expect(marketInstall()).rejects.toThrow(/disk full/);
    expect(await env.extensions!.get(ACCOUNT, HELLO_ID)).toMatchObject({
      version: '1.0.0',
      verified: true,
      signature: 'verified',
      publisher: { key: author.publicKey, trusted: true },
    });
    expect(pluginRow()).toEqual({
      source: 'catalog',
      origin: `cat/${HELLO_ID}@1.0.0`,
      signature: 'verified',
      version: '1.0.0',
    });
    expect(env.audit.find((a) => a.action === 'market.install.failed')?.detail).toMatchObject({
      rolledBack: true,
      version: '1.1.0',
      previousVersion: '1.0.0',
    });
  });
});
