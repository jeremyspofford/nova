// The Hub's firmware support matrix against novad's (FR-146, docs/23 §6): novad's table
// (services/novad/src/firmware.rs) is authoritative, since it reads the hardware. Both sides are
// checked against one fixture, services/novad/tests/fixtures/firmware-support-matrix.json (novad's
// `support_matrix_matches_the_shared_fixture` test checks its side), so a vendor key, driver
// folder or support change made on one side only fails a test.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRMWARE_SUPPORT_MATRIX, firmwareSupportFor } from '../src/m75/firmware.ts';

const fixture = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '../../../services/novad/tests/fixtures/firmware-support-matrix.json',
    ),
    'utf8',
  ),
) as unknown;

describe('the firmware support matrix', () => {
  it('matches novad: vendor, method, driver folder, support and key names', () => {
    expect(
      FIRMWARE_SUPPORT_MATRIX.map((e) => ({
        vendor: e.vendor,
        method: e.method,
        driver: e.driver,
        supported: e.supported,
        keys: e.keys,
      })),
    ).toEqual(fixture);
  });

  it('finds the vendor entry, generic UEFI, or a refusal', () => {
    expect(firmwareSupportFor({ vendor: 'Dell Inc.', uefi: true }).entry?.vendor).toBe('dell');
    expect(firmwareSupportFor({ vendor: 'Dell Inc.', uefi: true }).entry?.keys.bootOrder).toBe(
      undefined,
    );
    expect(firmwareSupportFor({ vendor: 'HP', uefi: true }).entry?.keys.tpm).toBe('TPM State');
    expect(firmwareSupportFor({ vendor: 'HPE', uefi: true }).entry?.vendor).toBe('generic-uefi');
    expect(firmwareSupportFor({ vendor: 'LENOVO', uefi: true }).entry?.driver).toBe('thinklmi');
    expect(firmwareSupportFor({ vendor: 'ASUSTeK COMPUTER INC.', uefi: true })).toMatchObject({
      supported: false,
      entry: { vendor: 'asus' },
    });
    expect(firmwareSupportFor({ vendor: 'Acme', uefi: false }).reason).toBe('legacy_bios');
    expect(firmwareSupportFor({ vendor: 'Dell Inc.', uefi: true }, 'windows').reason).toBe(
      'os_not_supported',
    );
    expect(firmwareSupportFor(null).reason).toBe('unknown_platform');
  });
});
