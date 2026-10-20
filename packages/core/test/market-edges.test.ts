// Marketplace edge cases (FR-049): an artifact whose version is not its entry's, an archive
// without the item at its root, a missing item or catalog index, folder catalogs that point at an
// https file, failed skill and pet updates put back, the saved-theme limit, pet files that are
// not pets, and the preview cap.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NovaDatabase } from '@nova/storage';
import { readPetFolder } from '../src/market/index.ts';
import {
  ACCOUNT,
  folderDigest,
  marketEnv,
  openMarketDb,
  petFolder,
  pluginFolder,
  sha256Hex,
  skillFolder,
  testPublisher,
  themeFile,
  writeCatalog,
  zipOf,
  type MarketEnv,
} from './fixtures/market/env.ts';

let dir: string;
let db: NovaDatabase;
let env: MarketEnv;
const key = testPublisher();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-market-edges-'));
  db = await openMarketDb();
  env = marketEnv(dir, db);
});
afterEach(() => {
  env.market.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function catalog(items: unknown[], name = 'c'): string {
  const root = join(dir, name);
  writeCatalog(root, { items }, key.privateKey);
  if (!env.catalogs.some((c) => c.id === name))
    env.catalogs.push({ id: name, name, location: root, publisherKey: key.publicKey });
  return root;
}

const preview = (
  kind: 'plugin' | 'skill' | 'theme' | 'pet' | 'mcp',
  id: string,
  version?: string,
) => env.market.preview(ACCOUNT, { catalogId: 'c', kind, id, ...(version ? { version } : {}) });

it('refuses an artifact whose version is not the one its entry lists', async () => {
  const root = join(dir, 'c');
  const p = pluginFolder(join(root, 'notes'), { version: '2.0.0' });
  catalog([
    {
      kind: 'plugin',
      id: 'com.test.notes',
      name: 'N',
      version: '1.0.0',
      path: 'notes',
      digest: folderDigest(p),
    },
  ]);
  await expect(preview('plugin', 'com.test.notes')).rejects.toThrow(
    /the item is version 2.0.0, but the catalog lists 1.0.0/,
  );
  await expect(preview('plugin', 'com.test.notes', '9.9.9')).rejects.toMatchObject({
    code: 'not_found',
  });
  // Nothing is left staged.
  const staging = join(dir, 'data', 'cache', 'market', 'staging');
  expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
});

it('finds the item in an archive’s single top folder, and refuses an archive without it', async () => {
  const root = join(dir, 'c');
  mkdirSync(root, { recursive: true });
  const good = zipOf(pluginFolder(join(dir, 'src')), 'notes-1.0.0/');
  const bad = zipOf(skillFolder(join(dir, 'skill'), 'tidy'));
  writeFileSync(join(root, 'good.zip'), good);
  writeFileSync(join(root, 'bad.zip'), bad);
  catalog([
    {
      kind: 'plugin',
      id: 'com.test.notes',
      name: 'N',
      version: '1.0.0',
      path: 'good.zip',
      sha256: sha256Hex(good),
    },
    {
      kind: 'plugin',
      id: 'com.test.bad',
      name: 'B',
      version: '1.0.0',
      path: 'bad.zip',
      sha256: sha256Hex(bad),
    },
  ]);
  expect((await preview('plugin', 'com.test.notes')).verification.status).toBe('verified');
  await expect(preview('plugin', 'com.test.bad')).rejects.toThrow(
    /the archive has no .nova-plugin\/plugin.json/,
  );
});

it('says when a folder catalog has no index', async () => {
  mkdirSync(join(dir, 'empty'));
  env.catalogs.push({ id: 'empty', name: 'Empty', location: join(dir, 'empty') });
  expect((await env.market.catalogs())[0]!.error).toMatch(/no catalog.json/);
});

it('reads a folder catalog’s item from an https URL, and refuses plain http', async () => {
  const theme = readFileSync(themeFile(join(dir, 't.json')));
  const seen: string[] = [];
  db.close();
  db = await openMarketDb();
  env = marketEnv(dir, db, {
    fetch: ((url: string) => {
      seen.push(url);
      return Promise.resolve(new Response(theme, { status: 200 }));
    }) as typeof fetch,
  });
  catalog([
    {
      kind: 'theme',
      id: 'com.test.dusk',
      name: 'Dusk',
      version: '1.0.0',
      url: 'https://cdn.example.com/dusk.json',
      sha256: sha256Hex(theme),
    },
    {
      kind: 'theme',
      id: 'com.test.http',
      name: 'Http',
      version: '1.0.0',
      url: 'http://cdn.example.com/dusk.json',
    },
  ]);
  expect((await preview('theme', 'com.test.dusk')).verification.status).toBe('verified');
  expect(seen).toEqual(['https://cdn.example.com/dusk.json']);
  await expect(preview('theme', 'com.test.http')).rejects.toThrow(/must be an https URL/);
});

it('puts a skill back when its update fails', async () => {
  const root = join(dir, 'c');
  const v1 = skillFolder(join(root, 'v1'), 'tidy');
  catalog([
    {
      kind: 'skill',
      id: 'tidy',
      name: 'T',
      version: '1.0.0',
      path: 'v1',
      digest: folderDigest(v1),
    },
  ]);
  const p1 = await preview('skill', 'tidy');
  await env.market.install(ACCOUNT, { previewId: p1.previewId });
  const v2 = skillFolder(join(root, 'v2'), 'tidy');
  writeFileSync(
    join(v2, 'SKILL.md'),
    readFileSync(join(v2, 'SKILL.md'), 'utf8').replace('Do the thing.', 'Do it twice.'),
  );
  catalog([
    {
      kind: 'skill',
      id: 'tidy',
      name: 'T',
      version: '2.0.0',
      path: 'v2',
      digest: folderDigest(v2),
    },
  ]);
  const real = env.installers.skill;
  const install = real.install.bind(real);
  real.install = async (req) => {
    await install(req);
    throw new Error('then it broke');
  };
  const p2 = await preview('skill', 'tidy');
  await expect(env.market.install(ACCOUNT, { previewId: p2.previewId })).rejects.toThrow(
    'then it broke',
  );
  expect((await env.skills.get(ACCOUNT, 'skill:import:tidy')).body).toContain('Do the thing.');
  expect((await env.market.installed(ACCOUNT))[0]).toMatchObject({
    itemId: 'tidy',
    version: '1.0.0',
  });
});

it('puts a pet back when its update fails', async () => {
  const root = join(dir, 'c');
  const v1 = petFolder(join(root, 'v1'), 'com.test.owl', '1.0.0');
  catalog([
    {
      kind: 'pet',
      id: 'com.test.owl',
      name: 'Owl',
      version: '1.0.0',
      path: 'v1',
      digest: folderDigest(v1),
    },
  ]);
  const p1 = await preview('pet', 'com.test.owl');
  await env.market.install(ACCOUNT, { previewId: p1.previewId });
  const v2 = petFolder(join(root, 'v2'), 'com.test.owl', '2.0.0');
  catalog([
    {
      kind: 'pet',
      id: 'com.test.owl',
      name: 'Owl',
      version: '2.0.0',
      path: 'v2',
      digest: folderDigest(v2),
    },
  ]);
  const real = env.installers.pet;
  const install = real.install.bind(real);
  real.install = async (req) => {
    await install(req);
    throw new Error('then it broke');
  };
  const p2 = await preview('pet', 'com.test.owl');
  expect(p2.replaces).toEqual({ version: '1.0.0' });
  await expect(env.market.install(ACCOUNT, { previewId: p2.previewId })).rejects.toThrow(
    'then it broke',
  );
  expect(env.pets.pets()[0]!.version).toBe('1.0.0');
});

it('stops using a theme it removes, so a reinstall does not quietly come back into use', async () => {
  const root = join(dir, 'c');
  const t = themeFile(join(root, 'dusk.json'));
  catalog([
    {
      kind: 'theme',
      id: 'com.test.dusk',
      name: 'Dusk',
      version: '1.0.0',
      path: 'dusk.json',
      sha256: sha256Hex(readFileSync(t)),
    },
  ]);
  const install = async () =>
    env.market.install(ACCOUNT, { previewId: (await preview('theme', 'com.test.dusk')).previewId });
  await install();
  // Another saved theme in use is left alone.
  env.themeInUse.id = 'com.test.other';
  await env.market.remove(ACCOUNT, 'theme', 'com.test.dusk');
  expect(env.themeInUse.id).toBe('com.test.other');
  await install();
  env.themeInUse.id = 'com.test.dusk';
  await env.market.remove(ACCOUNT, 'theme', 'com.test.dusk');
  expect(env.themeInUse.id).toBeNull();
  await install();
  expect(env.themeInUse.id).toBeNull();
  expect(env.themes.map((x) => x.id)).toEqual(['com.test.dusk']);
});

it('keeps at most 50 saved themes', async () => {
  for (let i = 0; i < 50; i++) env.themes.push({ id: `com.test.t${i}` });
  const root = join(dir, 'c');
  const t = themeFile(join(root, 'dusk.json'));
  catalog([
    {
      kind: 'theme',
      id: 'com.test.dusk',
      name: 'Dusk',
      version: '1.0.0',
      path: 'dusk.json',
      sha256: sha256Hex(readFileSync(t)),
    },
  ]);
  const p = await preview('theme', 'com.test.dusk');
  await expect(env.market.install(ACCOUNT, { previewId: p.previewId })).rejects.toThrow(
    /50 saved themes/,
  );
  expect(env.themes).toHaveLength(50);
  await expect(env.market.remove(ACCOUNT, 'theme', 'com.test.none')).rejects.toMatchObject({
    code: 'not_found',
  });
});

describe('pet folders', () => {
  it('refuses a missing or broken pet.json, other image types and oversized frames', () => {
    const root = join(dir, 'p');
    mkdirSync(root, { recursive: true });
    expect(() => readPetFolder(root)).toThrow(/no pet.json/);
    writeFileSync(join(root, 'pet.json'), '{');
    expect(() => readPetFolder(root)).toThrow(/not valid JSON/);
    writeFileSync(
      join(root, 'pet.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'com.test.owl',
        name: 'Owl',
        states: { thinking: { frames: ['a.png'] } },
      }),
    );
    expect(() => readPetFolder(root)).toThrow(/needs an idle state/);
    const pet = petFolder(join(dir, 'q'));
    const m = JSON.parse(readFileSync(join(pet, 'pet.json'), 'utf8')) as {
      states: { idle: { frames: string[] } };
    };
    writeFileSync(join(pet, 'frames', 'idle.gif'), 'gif');
    m.states.idle.frames = ['frames/idle.gif'];
    writeFileSync(join(pet, 'pet.json'), JSON.stringify(m));
    expect(() => readPetFolder(pet)).toThrow(/must be WebP, PNG or APNG/);
    writeFileSync(join(pet, 'frames', 'big.png'), Buffer.alloc(1024 * 1024 + 1));
    m.states.idle.frames = ['frames/big.png'];
    writeFileSync(join(pet, 'pet.json'), JSON.stringify(m));
    expect(() => readPetFolder(pet)).toThrow(/larger than 1 MB/);
  });

  it('leaves a damaged installed pet out of the list and refuses a bad id', () => {
    const petsDir = join(dir, 'data', 'market', 'pets');
    mkdirSync(join(petsDir, 'com.test.broken'), { recursive: true });
    expect(env.pets.pets()).toEqual([]);
    expect(() => env.pets.folder('../x')).toThrow(/invalid pet id/);
    expect(() => env.pets.folder('com.test.none')).toThrow(/not installed/);
  });
});

it('keeps at most 50 previews, dropping the oldest', async () => {
  const root = join(dir, 'c');
  const t = themeFile(join(root, 'dusk.json'));
  catalog([
    {
      kind: 'theme',
      id: 'com.test.dusk',
      name: 'Dusk',
      version: '1.0.0',
      path: 'dusk.json',
      sha256: sha256Hex(readFileSync(t)),
    },
  ]);
  const first = await preview('theme', 'com.test.dusk');
  for (let i = 0; i < 50; i++) {
    env.clock.now += 1000;
    await preview('theme', 'com.test.dusk');
  }
  await expect(env.market.install(ACCOUNT, { previewId: first.previewId })).rejects.toMatchObject({
    code: 'request_expired',
  });
});
