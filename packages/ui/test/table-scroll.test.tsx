import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TableScroll } from '../src/index.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function sizes(scrollWidth: number, clientWidth: number) {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth);
}

describe('TableScroll', () => {
  it('is a named keyboard stop only when its table is wider than the screen', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    sizes(500, 288);
    render(
      <TableScroll label="Shortcuts">
        <table>
          <tbody>
            <tr>
              <td>Wide</td>
            </tr>
          </tbody>
        </table>
      </TableScroll>,
    );
    const region = screen.getByRole('region', { name: 'Shortcuts' });
    expect(region.getAttribute('tabindex')).toBe('0');
    vi.restoreAllMocks();
  });

  it('adds no stop or landmark when the table fits', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    sizes(280, 288);
    render(
      <TableScroll label="Shortcuts">
        <p>Narrow</p>
      </TableScroll>,
    );
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getByText('Narrow').parentElement?.hasAttribute('tabindex')).toBe(false);
    vi.restoreAllMocks();
  });
});
