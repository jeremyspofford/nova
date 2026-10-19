// The companion's mood as a hook (FR-012): it follows the shared Work stream through the pure state
// machine in state.ts and ends a reaction when its time is up. Nova's own companions and pets
// installed from the marketplace (M8) share it.
import { useEffect, useReducer } from 'react';
import { useWorkEvents } from '../work/events.ts';
import { initialPet, petEventOf, petReducer, petState, type PetState } from './state.ts';

export function usePetMood(muted: boolean): PetState {
  const [model, dispatch] = useReducer(petReducer, initialPet);
  useWorkEvents((env) => {
    const ev = petEventOf(env, Date.now());
    if (ev) dispatch(ev);
  });
  // End a reaction when its time is up (a little after, so the tick is never early).
  const until = model.reaction?.until ?? null;
  useEffect(() => {
    if (until === null) return;
    const t = setTimeout(
      () => dispatch({ type: 'tick', at: Date.now() }),
      Math.max(0, until - Date.now()) + 20,
    );
    return () => clearTimeout(t);
  }, [until]);
  return petState(model, muted);
}
