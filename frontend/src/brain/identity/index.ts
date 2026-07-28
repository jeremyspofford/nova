/** The identity view — Nova with a face.
 *
 *  A presence renderer, like the orb: it ignores the memory graph entirely
 *  and draws only her. What it adds over the orb is that she is a person in
 *  a lit room, her mouth follows the audio actually playing, and she blinks
 *  and looks around like something that is alive rather than displayed.
 *
 *  Phase 1 deliberately does NOT chase the reference render's realism. The
 *  head is a stand-in (see head.ts) and the point of this pass is that the
 *  MOTION is right — the two previous attempts at a face were both rejected
 *  on motion after their art was already built.
 */

import * as THREE from 'three';
import type { LegendEntry, RendererHandle, RendererOpts } from '../theme';
import { FACECAP, loadHead, type Head } from './head';
import { createStage, setStagePixelRatio, type Stage } from './stage';
import { createFace, type Face } from './face';
import { createHair, type Hair } from './hair';
import { createBody, type Body } from './body';
import { MODE_COLOR, resolveMode, type Mode } from './mode';

export const IDENTITY_LEGEND: LegendEntry[] = [
  { color: MODE_COLOR.idle, label: 'Idle', note: 'present and quiet — she breathes, blinks and looks around' },
  { color: MODE_COLOR.listening, label: 'Listening', note: 'she turns to you and her brows lift' },
  { color: MODE_COLOR.thinking, label: 'Thinking', note: 'her gaze drifts off while a reply forms' },
  { color: MODE_COLOR.working, label: 'Working', note: 'focused — the air behind her warms' },
  { color: MODE_COLOR.speaking, label: 'Speaking', note: 'her mouth follows the audio, not a guess' },
];

const MAX_DPR = 2;

export function createIdentity(canvas: HTMLCanvasElement, _opts?: RendererOpts): RendererHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const stage: Stage = createStage();
  setStagePixelRatio(stage, Math.min(window.devicePixelRatio || 1, MAX_DPR));

  let head: Head | null = null;
  let face: Face | null = null;
  let hair: Hair | null = null;
  let body: Body | null = null;

  /** The single guard that makes async construction safe. Brain.tsx wraps the
   *  factory in try/catch, but that only catches a throwing constructor — a
   *  model that finishes loading after the view was torn down (StrictMode's
   *  double mount does this every time in dev) lands here instead. */
  let disposed = false;
  let paused = false;
  let raf = 0;
  let listening = false;
  let act: { active: boolean; kind?: string; at: number } = { active: false, at: 0 };
  let scale = 1;
  let width = 1, height = 1;

  void loadHead(FACECAP, renderer)
    .then(loaded => {
      if (disposed) { loaded.dispose(); return; }
      head = loaded;
      skinify(loaded);
      stage.scene.add(loaded.root);
      hair = createHair(loaded);
      stage.scene.add(hair.root);
      body = createBody(loaded);
      stage.scene.add(body.root);
      face = createFace(loaded);
    })
    .catch(err => {
      // A missing model must leave a calm, lit, empty room — never a white
      // screen and never an exception into Brain's render tree.
      console.error('[identity] head failed to load:', err);
    });

  let mode: Mode = 'idle';
  let last = performance.now() / 1000;
  let t = 0;

  const frame = () => {
    raf = requestAnimationFrame(frame);
    const now = performance.now() / 1000;
    // Clamped so a backgrounded tab or a slow model load does not integrate
    // a two-second step into the animation the moment it resumes.
    const dt = Math.min(now - last, 0.1);
    last = now;
    if (paused || document.hidden) return;
    t += dt;

    mode = resolveMode(listening, act);
    face?.update(dt, t, mode);
    hair?.update(t, face?.headTilt ?? null);
    body?.update(t, face?.breath ?? 0);
    stage.update(t);
    stage.setMood(MODE_COLOR3[mode], mode === 'idle' ? 0 : 0.35);
    stage.setPresence(face?.presence ?? 1);
    renderer.render(stage.scene, stage.camera);
  };
  raf = requestAnimationFrame(frame);

  if (import.meta.env.DEV) {
    // Diagnostics for the verification rig. The blink is the one that
    // matters: the last attempt shipped a blink that faded instead of
    // closing, and nobody could tell from a still.
    window.novaFace = {
      blink: () => face?.blink ?? 0,
      mode: () => mode,
      presence: () => face?.presence ?? 1,
      loaded: () => !!head,
    };
  }

  const onVisibility = () => { last = performance.now() / 1000; };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    setData() { /* a presence view has no graph */ },
    resize(w: number, h: number) {
      width = Math.max(1, w); height = Math.max(1, h);
      // updateStyle MUST stay on. With it off three sets the drawing buffer
      // to width*devicePixelRatio but leaves the element's CSS size unset,
      // so the canvas lays out at the buffer size — double scale on a HiDPI
      // screen, overflowing right and down and dragging the chat panel with it.
      renderer.setSize(width, height);
      stage.resize(width, height);
      applyScale();
    },
    setPaused(p: boolean) {
      paused = p;
      last = performance.now() / 1000;   // don't integrate the time spent paused
    },
    configure(options: Record<string, unknown>) {
      // orbScale is the voice overlay's "she is the whole screen now" knob;
      // the same option name the orb uses, so the overlay needs no special case
      if (typeof options.orbScale === 'number' && options.orbScale > 0) {
        scale = options.orbScale;
        applyScale();
      }
    },
    recenter() { face?.recentre(); },
    setActivity(state) {
      if (state.kind === 'listening') { listening = state.active; return; }
      act = { active: state.active, kind: state.kind, at: performance.now() };
    },
    destroy() {
      disposed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      hair?.dispose();
      body?.dispose();
      head?.dispose();
      stage.dispose();
      // dispose() frees the GPU resources; the context goes with the canvas
      // element, which Brain.tsx re-creates per renderer. NEVER
      // forceContextLoss() — a force-lost context can never be re-adopted,
      // and StrictMode runs this teardown on a canvas that is about to be
      // used again.
      renderer.dispose();
    },
  };

  function applyScale() {
    // Scale the SUBJECT rather than moving the camera: the backdrop glow is
    // positioned in screen space and should not slide when she grows.
    const s = scale;
    if (head) head.root.scale.setScalar(s);
    if (hair) hair.root.scale.setScalar(s);
    if (body) body.root.scale.setScalar(s);
  }
}

declare global {
  interface Window {
    novaFace?: {
      blink: () => number; mode: () => string;
      presence: () => number; loaded: () => boolean;
    };
  }
}

const MODE_COLOR3: Record<Mode, THREE.Color> = {
  idle: new THREE.Color(MODE_COLOR.idle),
  listening: new THREE.Color(MODE_COLOR.listening),
  thinking: new THREE.Color(MODE_COLOR.thinking),
  working: new THREE.Color(MODE_COLOR.working),
  speaking: new THREE.Color(MODE_COLOR.speaking),
};

/** The scan ships as a flat lambert. Give it skin-ish response so the key
 *  light reads as light on a face rather than a tinted decal. */
function skinify(h: Head) {
  for (const mesh of h.meshes) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial;
      if (!std.isMeshStandardMaterial) continue;
      std.roughness = 0.55;
      std.metalness = 0.0;
      // Warm the scan. Lit neutrally it reads waxy — pale, even, and
      // bloodless, which is most of the distance between "a person" and
      // "a mannequin". Tinting the albedo warm is cheaper and steadier than
      // trying to get it out of the lights alone.
      std.color.setHex(0xffd9c2);
      // The scan's interior faces are modelled; drawing both sides makes the
      // inside of the skull visible through a parted mouth.
      std.side = THREE.FrontSide;
      std.needsUpdate = true;
    }
  }
}
