// The optional companion (FR-012): a small original figure in a bottom corner that reacts to
// what Nova is doing: thinking while a thread runs, waiting when one needs the user, a hop when a
// run finishes and a droop when one fails. It is decoration only: hidden from assistive tech,
// never focusable, and clicks pass through it. Under reduced motion (or Keep still) it holds a
// still pose. It follows the shared Work stream, which carries `thread.status.changed` and
// `run.completed`; a failed chat turn (`turn.completed`) is not on that stream, so only runs
// trigger the error reaction.
import { useEffect, useReducer } from 'react';
import { useMediaQuery } from '../hooks.ts';
import { useSetting } from '../settings.tsx';
import { useWorkEvents } from '../work/events.ts';
import { initialPet, petEventOf, petReducer, petState, type PetState } from './state.ts';
import './pets.css';

export type PetKind = 'sprout' | 'spark';

export function PetOverlay() {
  const pet = useSetting('appearance.pet').value;
  const position = useSetting('appearance.petPosition').value;
  const muted = useSetting('appearance.petMuted').value;
  const motion = useSetting('appearance.reducedMotion').value;
  const osReduce = useMediaQuery('(prefers-reduced-motion: reduce)', false);
  if (pet === 'off') return null;
  const still = muted || motion === 'on' || (motion === 'system' && osReduce);
  return <Companion kind={pet} position={position} muted={muted} still={still} />;
}

function Companion({
  kind,
  position,
  muted,
  still,
}: {
  kind: PetKind;
  position: 'bottom-right' | 'bottom-left';
  muted: boolean;
  still: boolean;
}) {
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
  const state = petState(model, muted);
  return (
    <div
      className="pet"
      data-pet={kind}
      data-state={state}
      data-position={position}
      data-animate={still ? 'false' : 'true'}
      aria-hidden="true"
    >
      <svg viewBox="0 0 44 44" width="44" height="44" focusable="false">
        <ellipse className="pet-shadow" cx="22" cy="42" rx="10" ry="1.8" />
        <g className="pet-body">
          {kind === 'sprout' ? (
            <>
              <path className="pet-stem" d="M22 15V9" />
              <path className="pet-leaf" d="M22 10C25 4.5 32 4.5 34 7.5C31.5 11.5 26 12 22 10Z" />
              <circle className="pet-fill" cx="22" cy="28" r="13" />
              <g transform="translate(22 28)">
                <Face state={state} />
              </g>
            </>
          ) : (
            <>
              <path
                className="pet-fill pet-star"
                d="M22 9L26.4 18.9L37.2 20.1L29.1 27.3L31.4 37.9L22 32.5L12.6 37.9L14.9 27.3L6.8 20.1L17.6 18.9Z"
              />
              <g transform="translate(22 25.5) scale(0.8)">
                <Face state={state} />
              </g>
            </>
          )}
        </g>
        <Extras state={state} />
      </svg>
    </div>
  );
}

/** Eyes and mouth around (0, 0), one expression per state. */
function Face({ state }: { state: PetState }) {
  switch (state) {
    case 'idle':
      return (
        <>
          <circle className="pet-face" cx="-4.5" cy="-1" r="1.6" />
          <circle className="pet-face" cx="4.5" cy="-1" r="1.6" />
          <path className="pet-line" d="M-3 3.5Q0 6 3 3.5" />
        </>
      );
    case 'thinking':
      return (
        <>
          <circle className="pet-face" cx="-3.5" cy="-2.5" r="1.6" />
          <circle className="pet-face" cx="5.5" cy="-2.5" r="1.6" />
          <path className="pet-line" d="M-2 4.5H2" />
        </>
      );
    case 'waiting':
      return (
        <>
          <circle className="pet-face" cx="-4.5" cy="-1" r="1.6" />
          <circle className="pet-face" cx="4.5" cy="-1" r="1.6" />
          <circle className="pet-line" cx="0" cy="4.5" r="1.4" />
        </>
      );
    case 'success':
      return (
        <>
          <path className="pet-line" d="M-6-0.5Q-4.5-3-3-0.5M3-0.5Q4.5-3 6-0.5" />
          <path className="pet-line" d="M-4 3Q0 8 4 3" />
        </>
      );
    case 'error':
      return (
        <>
          <path className="pet-line" d="M-6-0.5L-3-2M6-0.5L3-2" />
          <path className="pet-line" d="M-3 6Q0 3 3 6" />
        </>
      );
  }
}

/** A small sign beside the figure: thought dots, a question mark, sparkles or a drop. */
function Extras({ state }: { state: PetState }) {
  switch (state) {
    case 'thinking':
      return (
        <g className="pet-extra">
          <circle cx="36" cy="13" r="1.2" />
          <circle cx="39.5" cy="8.5" r="1.7" />
        </g>
      );
    case 'waiting':
      return (
        <g className="pet-extra">
          <path className="pet-extra-line" d="M35 6.5a2.6 2.6 0 1 1 2.6 2.6v2" />
          <circle cx="37.6" cy="14" r="0.9" />
        </g>
      );
    case 'success':
      return (
        <g className="pet-extra">
          <path className="pet-extra-line" d="M37 4v5M34.5 6.5h5M7 9v4M5 11h4" />
        </g>
      );
    case 'error':
      return (
        <g className="pet-extra">
          <path d="M37 9c1.6 2.4 2.4 3.6 2.4 4.6a2.4 2.4 0 0 1-4.8 0c0-1 .8-2.2 2.4-4.6Z" />
        </g>
      );
    case 'idle':
      return null;
  }
}
