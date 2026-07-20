/** Nova theme — no memory nodes, just presence: a breathing particle-shell
 * orb whose light and motion follow what Nova is doing (idle / listening /
 * thinking / working / speaking). The Gemini/Jarvis register — an entity,
 * not a data visualization. Particles ride true 3D orbits; dragging the
 * canvas orbits the view around her.
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
  idle: 0.20, listening: 0.42, thinking: 0.6, working: 0.85, speaking: 0.38,
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

  // runtime settings (Brain HUD -> configure())
  let pace = 1;                                // rotationSpeed / 2 (0 = still)
  let labelMode: 'auto' | 'on' | 'off' = 'auto';
  let labelScale = 1;

  // view orientation — drag orbits the whole particle system around her
  let yaw = 0;
  let pitch = 0.15;

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
  // true 3D orbits (random plane through the center) — real enough that
  // dragging the view genuinely rotates around her
  const orbit3 = (radius: number) => {
    const t = rand() * Math.PI * 2, z = rand() * 2 - 1;
    const s = Math.sqrt(1 - z * z);
    const n = [s * Math.cos(t), s * Math.sin(t), z];       // orbit normal
    const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let u = [n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2],
             n[0] * ref[1] - n[1] * ref[0]];
    const ul = Math.hypot(u[0], u[1], u[2]);
    u = [u[0] / ul, u[1] / ul, u[2] / ul];
    const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2],
               n[0] * u[1] - n[1] * u[0]];
    return { radius, u, v, ang: rand() * Math.PI * 2 };
  };
  // ambient motes drifting far out
  const motes = Array.from({ length: 110 }, () => {
    const a = 1.7 + rand() * 2.9;              // orbit radius, in units of R
    return { ...orbit3(a), speed: (0.25 + rand() * 0.5) / a,
             size: 0.6 + rand() * 1.4, tw: rand() * Math.PI * 2 };
  });
  // the orb body itself — a fuzzy shell of matter, not a solid ball
  const shell = Array.from({ length: 640 }, () => {
    const rad = 1 + (rand() + rand() + rand() - 1.5) * 0.16;  // soft gaussian shell
    return { ...orbit3(rad), speed: 0.10 + rand() * 0.22,
             size: 0.5 + rand() * 1.1, tw: rand() * Math.PI * 2 };
  });
  let ripples: { life: number; dir: 1 | -1 }[] = [];   // listening rings (inward)
  let sparks: { x: number; y: number; vx: number; vy: number; life: number }[] = [];
  let lastInRipple = 0;                        // listening ring cadence
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
    // asymmetric envelope: quick to light up, slow to settle — her voice
    // breathes through the orb instead of strobing it
    const lv = speaker.level();
    lvlS += (lv - lvlS) * (1 - Math.exp(-dt / (lv > lvlS ? 90 : 450)));
    let cr = 0, cg = 0, cb = 0, energy = 0;
    for (const m of MODES) {
      const [r0, g0, b0] = rgb(MODE_COLOR[m]);
      cr += r0 * weight[m]; cg += g0 * weight[m]; cb += b0 * weight[m];
      energy += MODE_ENERGY[m] * weight[m];
    }
    energy = Math.min(1, energy + lvlS * 0.15 * weight.speaking);
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

    // shared view rotation: slow idle orbit + whatever the user dragged
    yaw += dt * 0.00004 * pace;
    const cyw = Math.cos(yaw), syw = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    // project a 3D orbiter to screen; d = normalized depth (-1 back, +1 front)
    const proj = (o: { radius: number; u: number[]; v: number[]; ang: number },
                  scale: number) => {
      const ca = Math.cos(o.ang), sa = Math.sin(o.ang);
      const px = o.radius * (ca * o.u[0] + sa * o.v[0]);
      const py = o.radius * (ca * o.u[1] + sa * o.v[1]);
      const pz = o.radius * (ca * o.u[2] + sa * o.v[2]);
      const x1 = px * cyw + pz * syw, z1 = pz * cyw - px * syw;
      const y2 = py * cp - z1 * sp, z2 = py * sp + z1 * cp;
      return { x: cx + x1 * scale, y: cy + y2 * scale, d: z2 / o.radius };
    };

    // motes — the ambient field that quickens as she engages
    const drift = dt * (0.3 + energy * 1.0) * pace;
    for (const mo of motes) {
      mo.ang += mo.speed * drift * 0.001;
      const s = proj(mo, R);
      const twinkle = 0.55 + 0.45 * Math.sin(now / 700 + mo.tw);
      ctx.fillStyle = col((0.1 + energy * 0.4) * twinkle * (0.7 + 0.3 * s.d));
      ctx.beginPath();
      ctx.arc(s.x, s.y, mo.size * (1 + 0.2 * s.d), 0, Math.PI * 2);
      ctx.fill();
    }

    // the orb: a fuzzy shell of matter around a soft inner light whose
    // focus slowly wanders — glow and dust, nothing solid, nothing static
    // breathing is pace-independent — even a stilled orb is alive; the glow
    // inhales with the radius so the breath is unmistakable
    const bphase = Math.sin(now / 2600);
    const breathe = 1 + bphase * 0.06;
    const bpulse = 0.5 + 0.5 * bphase;
    const r = R * breathe * (1 + lvlS * 0.06 * weight.speaking);
    const haloR = r * (2.4 + energy * 1.0);
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    halo.addColorStop(0, col(0.28 + energy * 0.20 + bpulse * 0.07));
    halo.addColorStop(0.4, col(0.09 + energy * 0.10 + bpulse * 0.03));
    halo.addColorStop(1, col(0));
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.fill();
    // inner light: gradual multi-stop falloff from a wandering focal point
    const fx = cx + Math.cos(now / 4700) * r * 0.18;
    const fy = cy + Math.sin(now / 6100) * r * 0.14;
    const body = ctx.createRadialGradient(fx, fy, 0, cx, cy, r * 1.05);
    body.addColorStop(0, `rgba(255,255,255,${0.27 + energy * 0.25 + bpulse * 0.07})`);
    body.addColorStop(0.3, col(0.45 + energy * 0.2));
    body.addColorStop(0.65, col(0.26));
    body.addColorStop(0.85, col(0.10));
    body.addColorStop(1, col(0));
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.05, 0, Math.PI * 2); ctx.fill();
    // the shell: slow-swirling dust; her voice brightens and gently
    // swells it — no snapping, no rings
    const swell = 1 + lvlS * 0.10 * weight.speaking;
    const spin = dt * (0.3 + energy * 0.6) * pace * 0.001;
    for (const p of shell) {
      p.ang += p.speed * spin;
      const s = proj(p, r * swell);
      const tw = 0.55 + 0.45 * Math.sin(now / 900 + p.tw);
      const a = (0.14 + bpulse * 0.05 + energy * 0.40 + lvlS * 0.15 * weight.speaking)
                * tw * (0.7 + 0.3 * s.d);
      ctx.fillStyle = col(a);
      const sz = p.size * (1 + 0.2 * s.d);
      if (sz < 1.1) {
        ctx.fillRect(s.x, s.y, sz + 0.4, sz + 0.4);
      } else {
        ctx.beginPath(); ctx.arc(s.x, s.y, sz, 0, Math.PI * 2); ctx.fill();
      }
    }

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

    // ripples: listening pulls rings inward (speech ripples removed —
    // Jeremy 2026-07-19: too chaotic; her voice lives in the shell now)
    if (weight.listening > 0.25 && now - lastInRipple > 1400 / Math.max(pace, 0.25)) {
      ripples.push({ life: 0, dir: -1 });
      lastInRipple = now;
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

    // state word only — the name tag is gone (Jeremy 2026-07-19: the orb
    // needs no caption); the word still surfaces when something happens
    ctx.globalCompositeOperation = 'source-over';
    if (labelMode !== 'off') {
      let sw: Mode | null = null;
      for (const m of MODES) if (m !== 'idle' && weight[m] > 0.35) sw = m;
      if (sw) {
        ctx.textAlign = 'center';
        ctx.font = `600 ${10 * labelScale}px system-ui`;
        ctx.shadowColor = col(1); ctx.shadowBlur = 12;
        ctx.fillStyle = col(0.75 * weight[sw]);
        ctx.fillText(sw.toUpperCase(), cx, cy + r * 2.5 + 18 * labelScale);
        ctx.shadowBlur = 0;
      }
    }

    raf = requestAnimationFrame(draw);
  }

  // click the orb = open the soul (the orb IS Nova, same as the galaxy
  // core); drag anywhere = orbit the view around her
  let dragging = false, dragDist = 0, lastX = 0, lastY = 0;
  const inOrb = (x: number, y: number) => {
    const R = Math.max(22, Math.min(110, Math.min(canvas.width, canvas.height) * 0.14));
    return (x - canvas.width / 2) ** 2 + (y - canvas.height / 2) ** 2 <= (R * 2) ** 2;
  };
  const onPointerDown = (e: PointerEvent) => {
    dragging = true; dragDist = 0; lastX = e.offsetX; lastY = e.offsetY;
    canvas.setPointerCapture(e.pointerId);
  };
  const onPointerUp = (e: PointerEvent) => {
    dragging = false;
    canvas.style.cursor = inOrb(e.offsetX, e.offsetY) ? 'pointer' : 'grab';
    if (dragDist > 6) return;                  // that was an orbit, not a click
    opts?.onNodeClick?.(inOrb(e.offsetX, e.offsetY) ? 'soul.md' : null);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (dragging) {
      const dx = e.offsetX - lastX, dy = e.offsetY - lastY;
      dragDist += Math.abs(dx) + Math.abs(dy);
      yaw += dx * 0.005;
      pitch += dy * 0.004;                     // unclamped — tumble freely
      lastX = e.offsetX; lastY = e.offsetY;
      canvas.style.cursor = 'grabbing';
      return;
    }
    canvas.style.cursor = inOrb(e.offsetX, e.offsetY) ? 'pointer' : 'grab';
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointermove', onPointerMove);

  raf = requestAnimationFrame(t => { lastNow = t; draw(t); });

  return {
    setData(_nodes: GraphNode[], _edges: GraphEdge[]) {
      // presence view — nothing is drawn from the graph (the name tag was
      // removed 2026-07-19; the orb needs no caption)
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
