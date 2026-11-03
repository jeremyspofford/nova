// Read the actual full-viewport raster as well as layout: visible DOM alone can accept a blank panel.
import type { Page } from 'playwright-core';
import { decodePng } from '../../src/core/browser/png.ts';

export async function diagnosticsPaint(page: Page, png: Buffer, selectors = ['#h-diagnostics', '.diagnostics-download summary', '[data-download-diagnostics]']) {
  const layout = await page.evaluate(selectors => {
    const scroller = document.querySelector('.scroller')!.getBoundingClientRect();
    return selectors.map(selector => {
      const element = document.querySelector(selector)!;
      const range = document.createRange(); range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      const color = getComputedStyle(element).color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { selector, text: element.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height, color, inside: rect.x >= scroller.left && rect.right <= scroller.right && rect.y >= scroller.top && rect.bottom <= scroller.bottom, hit: hit === element || !!hit && element.contains(hit), scroller: { x: scroller.x, y: scroller.y, width: scroller.width, height: scroller.height }, posture: document.body.dataset.posture };
    });
  }, selectors);
  const image = decodePng(png);
  const targets = layout.map(box => {
    let ink = 0;
    for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(image.height, Math.ceil(box.y + box.height)); y++) {
      for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(image.width, Math.ceil(box.x + box.width)); x++) {
        const offset = (y * image.width + x) * image.channels;
        if (box.color.every((channel, i) => Math.abs(image.data[offset + i]! - channel) <= 35)) ink++;
      }
    }
    return { ...box, ink };
  });
  return { targets, failures: targets.flatMap(box => [!box.inside && `${box.selector}: clipped by the real scroller`, !box.hit && `${box.selector}: obscured`, box.ink < 5 && `${box.selector}: no painted text`].filter(Boolean)) };
}
