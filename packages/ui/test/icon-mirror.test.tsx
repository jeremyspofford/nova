import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Icon, ICON_NAMES, MIRRORED_ICONS, type IconName } from '../src/index.ts';

afterEach(cleanup);

const svg = (ui: React.ReactElement) => render(ui).container.querySelector('svg')!;

describe('Icon mirroring under right-to-left (FR-016)', () => {
  it('marks every direction-bearing icon to mirror', () => {
    for (const name of ['back', 'forward', 'undo', 'redo', 'sidebar', 'inspector'] as const) {
      expect(MIRRORED_ICONS.has(name), name).toBe(true);
      expect(svg(<Icon name={name} />).getAttribute('data-mirror'), name).toBe('true');
      cleanup();
    }
  });

  it('never mirrors icons without a reading direction', () => {
    const fixed: IconName[] = ['search', 'send', 'terminal', 'clock', 'check', 'down', 'refresh'];
    for (const name of fixed) {
      expect(MIRRORED_ICONS.has(name), name).toBe(false);
      expect(svg(<Icon name={name} />).hasAttribute('data-mirror'), name).toBe(false);
      cleanup();
    }
  });

  it('lists only icons that exist', () => {
    for (const name of MIRRORED_ICONS) expect(ICON_NAMES).toContain(name);
  });

  it('lets a caller override the default either way', () => {
    expect(svg(<Icon name="forward" mirror={false} />).hasAttribute('data-mirror')).toBe(false);
    cleanup();
    expect(svg(<Icon name="search" mirror />).getAttribute('data-mirror')).toBe('true');
  });

  it('mirrors through one rule in the tokens, only where the direction is right-to-left', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/tokens.css'), 'utf8');
    const rule = /\.nv-icon\[data-mirror='true'\]:dir\(rtl\)\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/scale:\s*-1 1/);
    expect(css.match(/data-mirror/g)).toHaveLength(1);
  });
});
