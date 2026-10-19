// Re-sign the built-in sample catalog (FR-049, ADR-097 D2) after changing it: the sample
// extension in `src/word-count` is packed into `word-count-1.0.0.novax` and signed by its
// publisher (packing is reproducible), every entry with a `path` gets its checksum again (a
// folder's D2 `digest`, a file's `sha256`), the index is formatted with the repository's Prettier
// settings, and `catalog.json.sig` is written over the exact bytes. Run from the repository root:
//   node packages/core/test/fixtures/market/sign-sample-catalog.ts
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { folderDigest, signCatalogIndex } from '../../../src/market/index.ts';
import { sha256Hex } from '../../../src/market/signing.ts';
import { folderBundleFiles, packBundle } from '../../../src/sdk/bundle.ts';
import { loadPublisherPrivateKey } from '../../../src/sdk/keys.ts';
import { EXAMPLE_LABS_TEST_KEY_PEM, SAMPLE_CATALOG_TEST_KEY_PEM } from './sample-key.ts';

const CATALOG = fileURLToPath(new URL('../../../../../examples/catalog/', import.meta.url));

interface Entry {
  path?: string;
  sha256?: string;
  digest?: string;
}

function checksum(e: Entry): void {
  if (!e.path) return;
  const at = join(CATALOG, e.path);
  if (statSync(at).isDirectory()) {
    e.digest = folderDigest(at);
    delete e.sha256;
  } else {
    e.sha256 = sha256Hex(readFileSync(at));
    delete e.digest;
  }
}

/** The sample extension's bundle, signed by Example Labs. */
export function packSampleExtension(): Uint8Array {
  return packBundle(folderBundleFiles(join(CATALOG, 'src', 'word-count')), {
    privateKey: loadPublisherPrivateKey(EXAMPLE_LABS_TEST_KEY_PEM),
  }).bytes;
}

export async function signSampleCatalog(): Promise<void> {
  writeFileSync(join(CATALOG, 'word-count-1.0.0.novax'), packSampleExtension());
  const file = join(CATALOG, 'catalog.json');
  const index = JSON.parse(readFileSync(file, 'utf8')) as { plugins?: Entry[]; items?: Entry[] };
  for (const e of [...(index.plugins ?? []), ...(index.items ?? [])]) checksum(e);
  const config = (await prettier.resolveConfig(file)) ?? {};
  const text = await prettier.format(JSON.stringify(index, null, 2), { ...config, parser: 'json' });
  writeFileSync(file, text);
  const key = loadPublisherPrivateKey(SAMPLE_CATALOG_TEST_KEY_PEM);
  writeFileSync(file + '.sig', signCatalogIndex(Buffer.from(text), key));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await signSampleCatalog();
