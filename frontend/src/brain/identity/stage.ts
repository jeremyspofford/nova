/** The room she is in, and the light she is lit by.
 *
 *  Every previous face mockup here put a head in pure black at low key. That
 *  reads as a severed head in a void, which is most of why the screenshots
 *  are unsettling — a lit room and a warm key are doing more anti-uncanny
 *  work than any amount of shader polish.
 *
 *  Two rules from the reference (mockups/nova-humanistic.png):
 *    - WARM face, COOL surround. Her skin is peach against deep teal. The
 *      older mockups made the face blue too, which is exactly what makes a
 *      face read as a corpse.
 *    - Mode colour tints the ATMOSPHERE, never her. A violet-faced Nova
 *      reads wrong; violet air behind a normally-lit Nova reads as mood.
 */

import * as THREE from 'three';

export interface Stage {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Tint and lift the surround — mode colour, 0..1 strength. */
  setMood(colour: THREE.Color, strength: number): void;
  /** Overall presence: 1 fully present, ~0.75 idle-dimmed. Never 0 — she
   *  stays in the room. */
  setPresence(v: number): void;
  update(t: number): void;
  resize(w: number, h: number): void;
  dispose(): void;
}

const BG_DEEP = new THREE.Color('#061520');
const BG_MID = new THREE.Color('#0d2a3e');
const BG_GLOW = new THREE.Color('#1d5074');

const KEY_WARM = new THREE.Color('#ffd8b0');
const RIM_COOL = new THREE.Color('#5ba0ff');
const FILL_COOL = new THREE.Color('#7fa8d8');
const AMBIENT = new THREE.Color('#2f4459');

/** Vertical half-angle of the view. Wide enough to hold head AND shoulders —
 *  "too zoomed in" was the standing critique of the last attempt. */
const FOV = 26;

export function createStage(): Stage {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  // Slightly above her eyeline and a little back: a camera below the chin
  // looms, a camera far above condescends. Level and calm is the register.
  camera.position.set(0, 0.02, 4.15);
  camera.lookAt(0, -0.10, 0);

  const disposables = new Set<THREE.Material | THREE.BufferGeometry | THREE.Texture>();

  // ── backdrop ──────────────────────────────────────────────────────────
  // A shader plane rather than scene.background: it needs a glow centred
  // behind her head and a mood tint, and a flat colour gives neither.
  const bgUniforms = {
    uDeep: { value: BG_DEEP.clone() },
    uMid: { value: BG_MID.clone() },
    uGlow: { value: BG_GLOW.clone() },
    uMood: { value: new THREE.Color('#000000') },
    uMoodAmt: { value: 0 },
    uPresence: { value: 1 },
    uAspect: { value: 1 },
  };
  const bgGeo = new THREE.PlaneGeometry(2, 2);
  const bgMat = new THREE.ShaderMaterial({
    uniforms: bgUniforms,
    depthWrite: false,
    depthTest: false,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.999, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uDeep, uMid, uGlow, uMood;
      uniform float uMoodAmt, uPresence, uAspect;
      varying vec2 vUv;
      void main() {
        // vertical falloff: lighter around her, darker at the floor
        vec3 col = mix(uDeep, uMid, smoothstep(0.0, 0.85, vUv.y));
        // a soft pool of light behind the head, so she is separated from the
        // background by luminance and never has to rely on a rim alone
        vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.62);
        float halo = exp(-dot(p, p) * 5.5);
        col += uGlow * halo * 0.85;
        col = mix(col, uMood, uMoodAmt * (0.25 + 0.55 * halo));
        col *= mix(0.72, 1.0, uPresence);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  disposables.add(bgGeo); disposables.add(bgMat);
  const backdrop = new THREE.Mesh(bgGeo, bgMat);
  backdrop.frustumCulled = false;
  backdrop.renderOrder = -100;
  scene.add(backdrop);

  // ── motes ─────────────────────────────────────────────────────────────
  // Depth cues. The reference has out-of-focus specks; without something in
  // the air she reads as pasted onto a gradient.
  const MOTES = 90;
  const mPos = new Float32Array(MOTES * 3);
  const mSeed = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i++) {
    mPos[i * 3] = (Math.random() - 0.5) * 6;
    mPos[i * 3 + 1] = (Math.random() - 0.5) * 4;
    mPos[i * 3 + 2] = -2.4 + Math.random() * 3.4;
    mSeed[i] = Math.random() * Math.PI * 2;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
  moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(mSeed, 1));
  const moteUniforms = { uTime: { value: 0 }, uPixelRatio: { value: 1 }, uPresence: { value: 1 } };
  const moteMat = new THREE.ShaderMaterial({
    uniforms: moteUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute float aSeed;
      uniform float uTime, uPixelRatio;
      varying float vFade;
      void main() {
        vec3 p = position;
        p.y += sin(uTime * 0.13 + aSeed) * 0.16;
        p.x += cos(uTime * 0.09 + aSeed * 1.7) * 0.13;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        // nearer motes are bigger and softer — cheap depth of field
        gl_PointSize = (6.0 + 14.0 * smoothstep(-2.4, 1.0, p.z)) * uPixelRatio * (2.2 / -mv.z);
        vFade = 0.10 + 0.16 * (0.5 + 0.5 * sin(uTime * 0.4 + aSeed * 3.1));
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uPresence;
      varying float vFade;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        if (r > 0.5) discard;
        float a = smoothstep(0.5, 0.0, r);
        gl_FragColor = vec4(vec3(0.55, 0.76, 1.0), a * a * vFade * uPresence);
      }
    `,
  });
  disposables.add(moteGeo); disposables.add(moteMat);
  scene.add(new THREE.Points(moteGeo, moteMat));

  // ── light ─────────────────────────────────────────────────────────────
  const ambient = new THREE.AmbientLight(AMBIENT, 0.5);
  scene.add(ambient);

  // Key: warm, front-left, slightly above. This is the light that makes her
  // skin skin rather than a blue surface.
  const key = new THREE.DirectionalLight(KEY_WARM, 2.1);
  key.position.set(0.55, 0.75, 1.15);
  scene.add(key);

  // Rim: cool, behind and to the right — separates her from the backdrop and
  // gives the luminous contour the reference has.
  const rim = new THREE.DirectionalLight(RIM_COOL, 1.9);
  rim.position.set(-0.85, 0.45, -1.0);
  scene.add(rim);

  // Fill: cool, low, opposite the key — keeps shadow side from going to black
  // (a face with a black half is a horror lighting cue).
  const fill = new THREE.DirectionalLight(FILL_COOL, 0.45);
  fill.position.set(-0.9, -0.15, 0.85);
  scene.add(fill);

  // Catchlight: a small bright source near the camera. Its only job is the
  // specular dot in the eyes — "catchlight = alive" is a hard-won note here.
  const catchlight = new THREE.PointLight(0xffffff, 1.5, 12, 2);
  catchlight.position.set(0.28, 0.34, 1.9);
  scene.add(catchlight);

    // Bounce: a dim warm light from below-front, standing in for the light a
  // real room throws back up off a surface. Without it the underside of the
  // jaw and brow go cold and she reads as lit in a void.
  const bounce = new THREE.DirectionalLight(new THREE.Color('#ffcfa8'), 0.40);
  bounce.position.set(0.1, -0.9, 0.7);
  scene.add(bounce);

  const baseIntensity = { ambient: 0.5, key: 2.1, rim: 1.9, fill: 0.45, catch: 1.5, bounce: 0.40 };
  let presence = 1;

  return {
    scene,
    camera,
    setMood(colour, strength) {
      bgUniforms.uMood.value.copy(colour);
      bgUniforms.uMoodAmt.value = strength;
      // The rim is the ONE light allowed to carry mood, because it lands on
      // her contour rather than her face.
      rim.color.copy(RIM_COOL).lerp(colour, strength * 0.5);
    },
    setPresence(v) {
      presence = v;
      bgUniforms.uPresence.value = v;
      moteUniforms.uPresence.value = v;
      const k = 0.68 + 0.32 * v;
      ambient.intensity = baseIntensity.ambient * k;
      key.intensity = baseIntensity.key * k;
      rim.intensity = baseIntensity.rim * k;
      fill.intensity = baseIntensity.fill * k;
      catchlight.intensity = baseIntensity.catch * k;
      bounce.intensity = baseIntensity.bounce * k;
    },
    update(t) {
      moteUniforms.uTime.value = t;
      void presence;
    },
    resize(w, h) {
      camera.aspect = w / h;
      // Hold the FRAMING, not the field of view: on a narrow phone viewport a
      // fixed vertical FOV crops her shoulders away, which is the severed
      // look this whole file exists to avoid.
      const ref = 16 / 10;
      const a = w / h;
      camera.fov = a < ref
        ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(FOV) / 2) * (ref / a)))
        : FOV;
      camera.updateProjectionMatrix();
      bgUniforms.uAspect.value = a;
    },
    dispose() {
      for (const d of disposables) d.dispose();
      disposables.clear();
    },
  };
}

/** Pixel ratio has to reach the mote shader; kept here so index.ts does not
 *  have to know the stage's uniform names. */
export function setStagePixelRatio(stage: Stage, ratio: number) {
  stage.scene.traverse(o => {
    const pts = o as THREE.Points;
    const mat = pts.material as THREE.ShaderMaterial | undefined;
    if (pts.isPoints && mat?.uniforms?.uPixelRatio) mat.uniforms.uPixelRatio.value = ratio;
  });
}
