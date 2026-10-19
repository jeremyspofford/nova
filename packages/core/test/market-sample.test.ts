// The built-in sample catalog (FR-049, ADR-097 D2): its checked-in signature verifies with the key
// pinned in code, every item's checksum matches its files, and the fixture key is that key. After
// changing examples/catalog, re-sign it from the repository root:
//   node packages/core/test/fixtures/market/sign-sample-catalog.ts
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SAMPLE_CATALOG_PUBLIC_KEY,
  expectedChecksum,
  folderDigest,
  parseMarketIndex,
  verifyCatalogIndex,
} from '../src/market/index.ts';
import { sha256Hex } from '../src/market/signing.ts';
import { SAMPLE_CATALOG } from './fixtures/market/env.ts';
import { publisherKeyOf, loadPublisherPrivateKey } from '../src/sdk/keys.ts';
import {
  SAMPLE_CATALOG_TEST_KEY_PEM,
  SAMPLE_CATALOG_TEST_PUBLIC_KEY,
} from './fixtures/market/sample-key.ts';

const RESIGN = 'run node packages/core/test/fixtures/market/sign-sample-catalog.ts';

describe('the built-in sample catalog', () => {
  const index = readFileSync(join(SAMPLE_CATALOG, 'catalog.json'));
  const sig = readFileSync(join(SAMPLE_CATALOG, 'catalog.json.sig'));

  it('is signed by the key pinned in code', () => {
    expect(publisherKeyOf(loadPublisherPrivateKey(SAMPLE_CATALOG_TEST_KEY_PEM))).toBe(
      SAMPLE_CATALOG_PUBLIC_KEY,
    );
    expect(SAMPLE_CATALOG_TEST_PUBLIC_KEY).toBe(SAMPLE_CATALOG_PUBLIC_KEY);
    expect(
      verifyCatalogIndex(index, sig, { pinned: SAMPLE_CATALOG_PUBLIC_KEY, trusted: [] }).status,
      RESIGN,
    ).toBe('verified');
    // Pinned to that catalog only: as a trusted publisher it is unknown.
    expect(verifyCatalogIndex(index, sig, { trusted: [] }).status).toBe('untrusted');
  });

  it('lists a checksum that matches every item', () => {
    for (const e of parseMarketIndex(index, 'catalog.json').entries) {
      const at = join(SAMPLE_CATALOG, e.path!);
      const actual = statSync(at).isDirectory() ? folderDigest(at) : sha256Hex(readFileSync(at));
      expect(expectedChecksum(e), `${e.id}: ${RESIGN}`).toBe(actual);
    }
  });
});
