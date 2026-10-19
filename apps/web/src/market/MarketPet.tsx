// A pet installed from the marketplace as the companion (FR-012, FR-049; docs/14 §2.3): the pet's
// own frames for each state (idle, thinking, working, waiting, success, error), played at its frame
// rate and held on the first frame under reduced motion or Keep still. Like Nova's own companions
// it is decoration only (hidden from assistive tech, never focusable, clicks pass through) and
// follows the same mood. Frames come from the Hub (`/market/pets/:id/files/*`, images only).
import { useEffect, useState } from 'react';
import type { MarketPetView } from '@nova/shared';
import { usePetMood } from '../pets/mood.ts';
import type { PetState } from '../pets/state.ts';
import { useMarketApi } from './api-m8.ts';
import './market.css';

/** The frames for a mood: its own state, then a close one, then idle. */
export function petFrames(
  pet: MarketPetView,
  state: PetState,
): { frames: string[]; fps: number; loop: boolean } | null {
  const order: Record<PetState, string[]> = {
    idle: ['idle'],
    thinking: ['thinking', 'working', 'idle'],
    waiting: ['waiting', 'idle'],
    success: ['success', 'idle'],
    error: ['error', 'idle'],
  };
  for (const name of order[state]) {
    const s = pet.states[name];
    if (s && s.frames.length) return s;
  }
  const first = Object.values(pet.states).find((s) => s.frames.length);
  return first ?? null;
}

/** Installed pets (owner only); null while loading, [] when they cannot be read. */
export function useInstalledPets(): MarketPetView[] | null {
  const market = useMarketApi();
  const [pets, setPets] = useState<MarketPetView[] | null>(null);
  useEffect(() => {
    if (!market) return;
    let alive = true;
    market.listMarketPets().then(
      ({ items }) => alive && setPets(items),
      () => alive && setPets([]),
    );
    return () => {
      alive = false;
    };
  }, [market]);
  return market ? pets : [];
}

export function MarketCompanion({
  petId,
  position,
  muted,
  still,
}: {
  petId: string;
  position: 'bottom-right' | 'bottom-left';
  muted: boolean;
  still: boolean;
}) {
  const market = useMarketApi();
  const pets = useInstalledPets();
  const state = usePetMood(muted);
  const pet = pets?.find((p) => p.id === petId) ?? null;
  const set = pet ? petFrames(pet, state) : null;
  const count = set?.frames.length ?? 0;
  const fps = set?.fps ?? 1;
  // Frames advance per state; a new state starts at its first frame.
  const [tick, setTick] = useState<{ state: PetState; n: number }>({ state, n: 0 });
  const n = tick.state === state ? tick.n : 0;
  useEffect(() => {
    if (still || count < 2) return;
    const t = setInterval(
      () => setTick((x) => ({ state, n: (x.state === state ? x.n : 0) + 1 })),
      Math.max(40, Math.round(1000 / Math.max(1, Math.min(fps, 24)))),
    );
    return () => clearInterval(t);
  }, [still, count, fps, state]);
  if (!market || !pet || !set || count === 0) return null;
  const index = still ? 0 : set.loop ? n % count : Math.min(n, count - 1);
  return (
    <div
      className="pet pet-market"
      data-pet={petId}
      data-state={state}
      data-position={position}
      data-animate={still ? 'false' : 'true'}
      aria-hidden="true"
    >
      <img
        src={market.marketPetFrameUrl(pet.id, set.frames[index]!)}
        alt=""
        width={44}
        height={44}
        draggable={false}
      />
    </div>
  );
}
