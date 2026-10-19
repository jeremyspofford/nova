// The icon is drawn by our own script (no third-party asset): a PNG of the right size, with the
// blue square and the white spark, transparent at the corners.
import { describe, expect, it } from 'vitest';
import { ICON_SIZES, drawIcon, encodePng } from '../scripts/icons.mjs';

describe('the extension icon', () => {
  it('draws every size as an RGBA PNG', () => {
    expect(ICON_SIZES).toEqual([16, 32, 48, 128]);
    for (const size of ICON_SIZES) {
      const png = encodePng(size, size, drawIcon(size));
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
      expect([view.getUint32(16), view.getUint32(20), png[24], png[25]]).toEqual([
        size,
        size,
        8,
        6,
      ]);
    }
  });

  it('is blue at the edge, white in the middle and clear in the corner', () => {
    const size = 64;
    const px = drawIcon(size);
    const at = (x: number, y: number) => [
      ...px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
    ];
    expect(at(0, 0)[3]).toBe(0);
    expect(at(32, 32)).toEqual([255, 255, 255, 255]);
    expect(at(8, 32)).toEqual([36, 87, 214, 255]);
  });
});
