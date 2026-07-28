/** Hair.
 *
 *  The scan is bald, and every previous attempt shipped it bald. "No hair"
 *  was the standing complaint against v8, and v9/v10/v11 each tried to solve
 *  it with particle filaments and each was rejected for the same reason: a
 *  cloud of points beside a solid face reads as two different materials.
 *  So this is geometry — the same lit surface the face is, which is the one
 *  thing the particle versions could never be.
 *
 *  Built as a bob, after the reference render. The shape is described as a
 *  RADIAL PROFILE rather than a cap plus a curtain: for every azimuth the
 *  hair runs from the crown down to a hem, hugging the skull while it is
 *  above the widest point and falling almost straight below it. Describing
 *  it that way is what keeps the silhouette smooth — the first attempt built
 *  the dome and the fall as two surfaces and the seam between them read as a
 *  hard-edged box.
 *
 *  Every dimension is DERIVED from the head's own bounding box, so swapping
 *  the head asset does not leave the hair floating around the wrong skull.
 */

import * as THREE from 'three';
import type { Head } from './head';

export interface Hair {
  root: THREE.Group;
  update(t: number, tilt: THREE.Vector2 | null): void;
  dispose(): void;
}

const PHI_STEPS = 84;
const V_STEPS = 44;

/** Half-angle of the opening the face shows through, from straight ahead. */
const FACE_HALF = THREE.MathUtils.degToRad(54);
/** Width of the blend between fringe height and full length. Generous on
 *  purpose: a narrow transition is a vertical crease down the side of her
 *  head, which is what made the first version look like a hood. */
const FACE_BLEND = THREE.MathUtils.degToRad(34);

const HAIR_ROOT = new THREE.Color('#33587f');
const HAIR_TIP = new THREE.Color('#5d8ec2');

export function createHair(head: Head): Hair {
  const root = new THREE.Group();
  const disposables = new Set<THREE.Material | THREE.BufferGeometry>();

  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  head.bounds.getSize(size);
  head.bounds.getCenter(centre);

  // Origin the hair is measured around. Ear height, not the middle of the
  // box, and pushed back off the nose — the box's +Z is the nose tip, and a
  // centre placed there tilts the whole scalp field forward.
  const cx = centre.x;
  const cy = centre.y;
  const ry = head.bounds.max.y - cy;       // crown height above that origin
  const cz = centre.z - size.z * 0.045;

  const thickness = size.x * 0.045;
  const hemSide = cy - ry * 0.80;          // a jaw-length bob
  const hemFront = cy + ry * 0.26;         // a blunt fringe, just above the brow

  // ── the scalp, measured ───────────────────────────────────────────────
  // An analytic ellipsoid is not the shape of a skull. Fitted by hand it sat
  // inside the forehead and the bald top of her head poked through the hair.
  // So the surface is SAMPLED from the head's own vertices: a spherical
  // height field around the cranium centre, R(theta, phi) = how far the skin
  // reaches in that direction. It fits whatever head the seam is given.
  const C = new THREE.Vector3(cx, cy + size.y * 0.06, cz);
  const T_BINS = 40, P_BINS = 96;
  const field = new Float32Array(T_BINS * P_BINS).fill(-1);
  {
    const v = new THREE.Vector3();
    for (const mesh of head.meshes) {
      const pos = mesh.geometry.getAttribute('position');
      if (!pos) continue;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).sub(C);
        const r = v.length();
        if (r < 1e-6) continue;
        const ti = Math.min(T_BINS - 1, Math.floor((Math.acos(v.y / r) / Math.PI) * T_BINS));
        let ph = Math.atan2(v.x, v.z);
        if (ph < 0) ph += Math.PI * 2;
        const pi = Math.min(P_BINS - 1, Math.floor((ph / (Math.PI * 2)) * P_BINS));
        const k = ti * P_BINS + pi;
        if (r > field[k]) field[k] = r;
      }
    }
    // Fill bins no vertex landed in, then smooth — a height field straight
    // off a point cloud is lumpy, and lumps in hair read as damage.
    for (let pass = 0; pass < 6; pass++) fillAndSmooth(field, T_BINS, P_BINS, pass < 3);
  }

  /** Skull reach in a direction, bilinear across the field. */
  function reach(theta: number, phi: number): number {
    const tf = Math.min(T_BINS - 1.001, Math.max(0, (theta / Math.PI) * T_BINS - 0.5));
    let ph = phi % (Math.PI * 2); if (ph < 0) ph += Math.PI * 2;
    const pf = (ph / (Math.PI * 2)) * P_BINS - 0.5;
    const t0 = Math.floor(tf), p0 = Math.floor(pf);
    const dt = tf - t0, dp = pf - p0;
    const at = (ti: number, pi: number) =>
      field[Math.max(0, Math.min(T_BINS - 1, ti)) * P_BINS + ((pi % P_BINS) + P_BINS) % P_BINS];
    return (at(t0, p0) * (1 - dp) + at(t0, p0 + 1) * dp) * (1 - dt)
      + (at(t0 + 1, p0) * (1 - dp) + at(t0 + 1, p0 + 1) * dp) * dt;
  }

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    // Rough enough not to read as moulded plastic: a low-roughness dome under
    // a point light grows specular blobs, which is what the first pass did.
    roughness: 0.58,
    metalness: 0.0,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  disposables.add(material);

  const geo = build();
  disposables.add(geo);
  root.add(new THREE.Mesh(geo, material));

  return {
    root,
    update(t, tilt) {
      // Hair lags the head very slightly — the cheapest possible cue that it
      // is hair and not a painted-on shell.
      root.rotation.set(
        (tilt ? tilt.y * 0.32 : 0) + Math.sin(t * 0.27) * 0.004,
        (tilt ? tilt.x * 0.32 : 0) + Math.sin(t * 0.19) * 0.005,
        0,
      );
    },
    dispose() {
      for (const d of disposables) d.dispose();
      disposables.clear();
    },
  };

  /** 0 straight ahead, 1 at the sides and back. */
  function backness(phi: number): number {
    const fromFront = Math.abs(wrap(phi));
    return THREE.MathUtils.smoothstep(fromFront, FACE_HALF - FACE_BLEND / 2, FACE_HALF + FACE_BLEND / 2);
  }

  function hemAt(phi: number): number {
    const b = backness(phi);
    // a shallow wave so the hem is not a machined edge
    const wave = Math.sin(phi * 3.0) * ry * 0.035 * b;
    return THREE.MathUtils.lerp(hemFront, hemSide, b) + wave;
  }

  /** Polar angle at which hair stops for this azimuth: march down the skull
   *  until the surface drops below the hem height for this direction. */
  function hemTheta(phi: number): number {
    const hem = hemAt(phi);
    const STEPS = 64;
    for (let i = 1; i <= STEPS; i++) {
      const th = (i / STEPS) * Math.PI * 0.92;
      if (C.y + Math.cos(th) * reach(th, phi) < hem) return th;
    }
    return Math.PI * 0.92;
  }

  function build(): THREE.BufferGeometry {
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    const shade = new THREE.Color();
    for (let i = 0; i <= PHI_STEPS; i++) {
      const phi = (i / PHI_STEPS) * Math.PI * 2;
      const thHem = hemTheta(phi);
      const sinP = Math.sin(phi), cosP = Math.cos(phi);
      // Where the skull stops being the thing hair rests on and starts being
      // a jaw: below this the hair hangs rather than hugs.
      const thFall = Math.PI * 0.52;
      for (let j = 0; j <= V_STEPS; j++) {
        const v = j / V_STEPS;
        const th = v * thHem;
        // Volume: hair is thickest over the crown and at the sides, thinnest
        // right at the fringe edge so it does not read as a slab.
        const vol = thickness * (0.55 + 0.75 * Math.sin(Math.min(1, th / thFall) * Math.PI * 0.75));
        const r = reach(th, phi) + vol;
        let x = C.x + Math.sin(th) * sinP * r;
        let y = C.y + Math.cos(th) * r;
        let z = C.z + Math.sin(th) * cosP * r;
        if (th > thFall) {
          // Past the widest point it falls under its own weight instead of
          // curling back under the jaw the way the skull surface does.
          const drop = (th - thFall) / Math.max(1e-3, thHem - thFall);
          const rWide = reach(thFall, phi) + thickness * 1.3;
          const tuck = 1 - 0.16 * drop * drop;
          x = C.x + sinP * rWide * tuck;
          z = C.z + cosP * rWide * tuck;
          y = C.y + Math.cos(thFall) * (reach(thFall, phi) + thickness)
            - drop * (C.y + Math.cos(thFall) * reach(thFall, phi) - hemAt(phi));
        }
        pos.push(x, y, z);
        // Strand-ish tonal variation. A single smooth shell lit by one key
        // reads as moulded plastic no matter what the roughness is; banding
        // the colour along the azimuth gives the eye something to read as
        // separate locks without paying for actual strand geometry.
        const strand = 0.5 + 0.5 * Math.sin(phi * 17.0 + Math.sin(phi * 6.3) * 1.7);
        const depth = Math.pow(v, 0.7) * 0.7;
        shade.copy(HAIR_ROOT).lerp(HAIR_TIP, depth);
        shade.multiplyScalar(0.80 + 0.28 * strand);
        col.push(shade.r, shade.g, shade.b);
      }
    }
    const row = V_STEPS + 1;
    for (let i = 0; i < PHI_STEPS; i++) {
      for (let j = 0; j < V_STEPS; j++) {
        const a = i * row + j, b = a + row;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
}

/** One pass of hole-filling (bins no vertex reached) and blurring over the
 *  spherical height field. Wraps in phi, clamps in theta. */
function fillAndSmooth(f: Float32Array, T: number, P: number, fillOnly: boolean) {
  const out = new Float32Array(f.length);
  for (let t = 0; t < T; t++) {
    for (let p = 0; p < P; p++) {
      const k = t * P + p;
      let sum = 0, n = 0;
      for (let dt = -1; dt <= 1; dt++) {
        for (let dp = -1; dp <= 1; dp++) {
          const tt = t + dt;
          if (tt < 0 || tt >= T) continue;
          const pp = ((p + dp) % P + P) % P;
          const val = f[tt * P + pp];
          if (val >= 0) { sum += val; n++; }
        }
      }
      out[k] = f[k] >= 0 ? (fillOnly ? f[k] : (f[k] * 2 + sum / Math.max(1, n)) / 3)
        : (n ? sum / n : -1);
    }
  }
  f.set(out);
}

/** Wrap to (-PI, PI] so "distance from straight ahead" is meaningful. */
function wrap(a: number) {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
}
