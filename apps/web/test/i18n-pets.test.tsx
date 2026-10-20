// The companion's settings in the pseudo-locale (FR-016): the choices, corners and Keep still come
// from messages. The overlay itself is decoration, hidden from assistive tech, with no words.
import { afterEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { PetOverlay } from '../src/pets/PetOverlay.tsx';
import { PET_TEXT, PetSettings } from '../src/pets/PetSettings.tsx';
import { renderWithSpaces } from './fakes-m6-spaces.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

describe('the companion in a pseudo-locale', () => {
  it('shows the companion settings localized', async () => {
    await activateTestLocale('en-XA');
    const { container } = await renderWithSpaces(
      <>
        <PetSettings />
        <PetOverlay />
      </>,
    );
    expect(screen.getByRole('heading', { name: PET_TEXT.title })).toBeTruthy();
    // The second choice is Sprout (Off, Sprout, Spark).
    await userEvent.click(screen.getAllByRole('radio')[1]!);
    await screen.findByRole('radio', { name: PET_TEXT.position.bottomLeft });
    expectFullyLocalized(container);
  });
});
