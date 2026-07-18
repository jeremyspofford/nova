/** Nova theme — no memory nodes, just presence: a breathing orb whose light
 * and motion follow what Nova is doing (idle / listening / thinking /
 * working / speaking). The Gemini/Jarvis register — an entity, not a data
 * visualization.
 *
 * Inputs: `speaker` (voice output amplitude drives the speaking glow — live
 * today) and the `setActivity` contract (chat stream / dispatch / tool / mic
 * events). The ChatPanel dispatch side of that wiring lands with the
 * brain-activity item; until then thinking/working/listening only fire when
 * something emits `nova:chat-activity`.
 */

import type { GraphNode, GraphEdge } from '../api';
import type { LegendEntry, RendererHandle, RendererOpts } from './theme';
import { speaker } from '../voice/speech';

type Mode = 'idle' | 'listening' | 'thinking' | 'working' | 'speaking';
const MODES: Mode[] = ['idle', 'listening', 'thinking', 'working', 'speaking'];

const MODE_COLOR: Record<Mode, string> = {
  idle: '#2dd4bf',
  listening: '#38bdf8',
  thinking: '#a78bfa',
  working: '#fbbf24',
  speaking: '#99f6e4',
};

// target intensity per mode — everything eases toward it, nothing snaps
const MODE_ENERGY: Record<Mode, number> = {
  idle: 0.16, listening: 0.42, thinking: 0.6, working: 0.85, speaking: 0.55,
};

export const NOVA_LEGEND: LegendEntry[] = [
  { color: MODE_COLOR.idle, label: 'Idle', note: 'a slow breath at rest' },
  { color: MODE_COLOR.listening, label: 'Listening', note: 'rings draw inward while the mic is open' },
  { color: MODE_COLOR.thinking, label: 'Thinking', note: 'arcs circle the core while a reply forms' },
  { color: MODE_COLOR.working, label: 'Working', note: 'sparks fly on dispatches and tool calls' },
  { color: MODE_COLOR.speaking, label: 'Speaking', note: 'the glow follows her voice' },
];

/** Deterministic PRNG — the mote field must not reshuffle on re-mount. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

export function createNova(canvas: HTMLCanvasElement, opts?: RendererOpts): RendererHandle {
  const ctx = canvas.getContext('2d')!;
  let raf = 0;
  let name = 'Nova';

  // runtime settings (Brain HUD -> configure())
  let pace = 1;                                // rotationSpeed / 2 (0 = still)
  let labelMode: 'auto' | 'on' | 'off' = 'auto';
  let labelScale = 1;

  // ── state machine ────────────────────────────────────────────────────
  // chat activity arrives via setActivity; speaking is polled off the
  // speaker singleton so it needs no wiring at all
  let act = { active: false, kind: undefined as string | undefined, at: 0 };
  let listening = false;
  const weight: Record<Mode, number> = {
    idle: 1, listening: 0, thinking: 0, working: 0, speaking: 0,
  };
  let lvlS = 0;                                // smoothed voice amplitude

  function resolveMode(now: number): Mode {
    // a stream that died without a done event must not think forever
    const fresh = act.active && now - act.at < 90_000;
    if (speaker.speaking) return 'speaking';
    // tool/dispatch events flash "working", then settle back into thinking
    if (fresh && (act.kind === 'tool' || act.kind === 'dispatch') && now - act.at < 4000) return 'working';
    if (fresh) return 'thinking';
    if (listening) return 'listening';
    return 'idle';
  }

  // ── ornaments ────────────────────────────────────────────────────────
  const rand = mulberry32(2077);
  const bgStars = Array.from({ length: 140 }, () => ({
    x: rand(), y: rand(), r: rand() * 1.1 + 0.2, a: rand() * 0.35 + 0.08,
  }));
  // motes on tilted elliptical orbits — pseudo-3D without a camera
  const motes = Array.from({ length: 110 }, () => {
    const a = 1.7 + rand() * 2.9;              // orbit radius, in units of R
    return {
      a,
      ang: rand() * Math.PI * 2,
      speed: (0.25 + rand() * 0.5) / a,        // outer orbits drift slower
      tilt: 0.3 + rand() * 0.55,
      plane: rand() * Math.PI * 2,
      size: 0.6 + rand() * 1.4,
      tw: rand() * Math.PI * 2,
    };
  });
  let ripples: { life: number; dir: 1 | -1 }[] = [];   // dir 1 = outward (speech)
  let sparks: { x: number; y: number; vx: number; vy: number; life: number }[] = [];
  let lastInRipple = 0;                        // listening ring cadence
  let lastOutRipple = 0;                       // speech ripple cooldown
  let lastNow = performance.now();

  function spawnSparks(cx: number, cy: number, ringR: number) {
    for (let i = 0; i < 14; i++) {
      const ang = rand() * Math.PI * 2;
      const v = (0.9 + rand() * 1.6) * ringR / 900;
      sparks.push({
        x: cx + Math.cos(ang) * ringR, y: cy + Math.sin(ang) * ringR,
        vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, life: 1,
      });
    }
  }
  let pendingSparks = 0;                       // set by setActivity, spent in draw

  function draw(now: number) {
    const dt = Math.min(64, now - lastNow);    // clamp: background tabs jump
    lastNow = now;
    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2;
    const R = Math.max(22, Math.min(110, Math.min(w, h) * 0.14));

    // ease mode weights, then blend color + energy from them — crossfades,
    // never snaps; speaking energy rides the live amplitude on top
    const mode = resolveMode(now);
    const k = 1 - Math.exp(-dt / 300);
    for (const m of MODES) weight[m] += ((m === mode ? 1 : 0) - weight[m]) * k;
    lvlS += (speaker.level() - lvlS) * 0.35;
    let cr = 0, cg = 0, cb = 0, energy = 0;
    for (const m of MODES) {
      const [r0, g0, b0] = rgb(MODE_COLOR[m]);
      cr += r0 * weight[m]; cg += g0 * weight[m]; cb += b0 * weight[m];
      energy += MODE_ENERGY[m] * weight[m];
    }
    energy = Math.min(1, energy + lvlS * 0.5 * weight.speaking);
    const col = (a: number) => `rgba(${cr | 0}, ${cg | 0}, ${cb | 0}, ${a})`;

    // deep space + a nebula halo that warms with activity
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#060505';
    ctx.fillRect(0, 0, w, h);
    const neb = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.55);
    neb.addColorStop(0, col(0.05 + energy * 0.07));
    neb.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = neb; ctx.fillRect(0, 0, w, h);
    for (const st of bgStars) {
      ctx.fillStyle = `rgba(255,255,255,${st.a})`;
      ctx.fillRect(st.x * w, st.y * h, st.r, st.r);
    }

    ctx.globalCompositeOperation = 'lighter';

    // motes — the ambient field that quickens as she engages
    const drift = dt * (0.3 + energy * 1.9) * pace;
    for (const mo of motes) {
      mo.ang += mo.speed * drift * 0.001;
      const ex = Math.cos(mo.ang) * mo.a * R, ey = Math.sin(mo.ang) * mo.a * R * mo.tilt;
      const x = cx + ex * Math.cos(mo.plane) - ey * Math.sin(mo.plane);
      const y = cy + ex * Math.sin(mo.plane) + ey * Math.cos(mo.plane);
      const twinkle = 0.55 + 0.45 * Math.sin(now / 700 + mo.tw);
      ctx.fillStyle = col((0.1 + energy * 0.4) * twinkle);
      ctx.beginPath(); ctx.arc(x, y, mo.size, 0, Math.PI * 2); ctx.fill();
    }

    // the orb: wide halo, colored body, white-hot center — breathing at rest,
    // swelling with her voice
    const breathe = 1 + Math.sin(now / 2600) * 0.04 * (0.5 + pace * 0.5);
    const r = R * breathe * (1 + lvlS * 0.22 * weight.speaking);
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * (2.6 + energy * 1.3));
    halo.addColorStop(0, col(0.5 + energy * 0.3));
    halo.addColorStop(0.35, col(0.16 + energy * 0.18));
    halo.addColorStop(1, col(0));
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, r * (2.6 + energy * 1.3), 0, Math.PI * 2); ctx.fill();
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    core.addColorStop(0, `rgba(255,255,255,${0.75 + energy * 0.25})`);
    core.addColorStop(0.45, col(0.85));
    core.addColorStop(1, col(0));
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

    // thinking / working arcs — segments circling the core; working adds a
    // faster counter-rotating outer ring
    const wThink = weight.thinking + weight.working;
    if (wThink > 0.02) {
      const spin = now * 0.0011 * (0.5 + energy) * Math.max(pace, 0.15);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = col(0.55 * wThink);
      for (let i = 0; i < 3; i++) {
        const a0 = spin + i * (Math.PI * 2 / 3);
        ctx.beginPath(); ctx.arc(cx, cy, r * 1.55, a0, a0 + 0.7); ctx.stroke();
      }
      if (weight.working > 0.02) {
        ctx.strokeStyle = col(0.5 * weight.working);
        for (let i = 0; i < 4; i++) {
          const a0 = -spin * 1.7 + i * (Math.PI / 2);
          ctx.beginPath(); ctx.arc(cx, cy, r * 1.85, a0, a0 + 0.45); ctx.stroke();
        }
      }
    }

    // ripples: listening pulls rings inward, speech pushes them out
    if (weight.listening > 0.25 && now - lastInRipple > 1400 / Math.max(pace, 0.25)) {
      ripples.push({ life: 0, dir: -1 });
      lastInRipple = now;
    }
    if (weight.speaking > 0.3 && lvlS > 0.28 && now - lastOutRipple > 300) {
      ripples.push({ life: 0, dir: 1 });
      lastOutRipple = now;
    }
    ripples = ripples.filter(rp => (rp.life += dt / 1600) < 1);
    ctx.lineWidth = 1.2;
    for (const rp of ripples) {
      const p = rp.dir === 1 ? rp.life : 1 - rp.life;
      ctx.strokeStyle = col(0.4 * Math.sin(rp.life * Math.PI));
      ctx.beginPath(); ctx.arc(cx, cy, r * (1.15 + p * 2.3), 0, Math.PI * 2); ctx.stroke();
    }

    // tool sparks — brief, radial, gone
    while (pendingSparks > 0) { spawnSparks(cx, cy, r * 1.7); pendingSparks--; }
    sparks = sparks.filter(sp => (sp.life -= dt / 900) > 0);
    for (const sp of sparks) {
      sp.x += sp.vx * dt; sp.y += sp.vy * dt;
      ctx.fillStyle = col(0.7 * sp.life);
      ctx.beginPath(); ctx.arc(sp.x, sp.y, 1.6, 0, Math.PI * 2); ctx.fill();
    }

    // identity + state — her name anchors the orb; the state word only
    // surfaces when something is happening
    ctx.globalCompositeOperation = 'source-over';
    if (labelMode !== 'off') {
      ctx.textAlign = 'center';
      ctx.font = `500 ${14 * labelScale}px system-ui`;
      ctx.shadowColor = col(1); ctx.shadowBlur = 12;
      ctx.fillStyle = 'rgba(235, 250, 250, 0.9)';
      ctx.fillText(name, cx, cy + r * 2.5 + 18 * labelScale);
      let sw: Mode | null = null;
      for (const m of MODES) if (m !== 'idle' && weight[m] > 0.35) sw = m;
      if (sw) {
        ctx.font = `600 ${10 * labelScale}px system-ui`;
        ctx.fillStyle = col(0.75 * weight[sw]);
        ctx.fillText(sw.toUpperCase(), cx, cy + r * 2.5 + 34 * labelScale);
      }
      ctx.shadowBlur = 0;
    }

    raf = requestAnimationFrame(draw);
  }

  // click the orb = open the soul (the orb IS Nova, same as the galaxy core)
  let downX = 0, downY = 0;
  const inOrb = (x: number, y: number) => {
    const R = Math.max(22, Math.min(110, Math.min(canvas.width, canvas.height) * 0.14));
    return (x - canvas.width / 2) ** 2 + (y - canvas.height / 2) ** 2 <= (R * 2) ** 2;
  };
  const onPointerDown = (e: PointerEvent) => { downX = e.offsetX; downY = e.offsetY; };
  const onPointerUp = (e: PointerEvent) => {
    if (Math.abs(e.offsetX - downX) + Math.abs(e.offsetY - downY) > 6) return;
    opts?.onNodeClick?.(inOrb(e.offsetX, e.offsetY) ? 'soul.md' : null);
  };
  const onPointerMove = (e: PointerEvent) => {
    canvas.style.cursor = inOrb(e.offsetX, e.offsetY) ? 'pointer' : 'default';
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointermove', onPointerMove);

  raf = requestAnimationFrame(t => { lastNow = t; draw(t); });

  return {
    setData(nodes: GraphNode[], _edges: GraphEdge[]) {
      // presence view — the only thing taken from the graph is her name
      name = nodes.find(n => n.type === 'core')?.label ?? name;
    },
    resize(width: number, height: number) {
      canvas.width = width;
      canvas.height = height;
    },
    configure(options: Record<string, unknown>) {
      if (typeof options.rotationSpeed === 'number') pace = options.rotationSpeed / 2;
      if (typeof options.labelScale === 'number') labelScale = options.labelScale;
      if (options.labelMode === 'auto' || options.labelMode === 'on' || options.labelMode === 'off') {
        labelMode = options.labelMode;
      }
    },
    setActivity(state: { active: boolean; kind?: 'thinking' | 'dispatch' | 'tool' | 'listening' }) {
      if (state.kind === 'listening') { listening = state.active; return; }
      act = { active: state.active, kind: state.kind, at: performance.now() };
      if (state.active && (state.kind === 'tool' || state.kind === 'dispatch')) pendingSparks++;
    },
    destroy() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointermove', onPointerMove);
    },
  };
}
