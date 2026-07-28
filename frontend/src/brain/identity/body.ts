/** A neck and shoulders, and the reason they exist.
 *
 *  The single most unsettling thing about every previous mockup in this repo
 *  is not the face — it is that the face ends. A head cropped at the jaw and
 *  hung in the dark is a severed head, and no amount of gentle blinking
 *  fixes that read. Giving her a body below the frame costs almost nothing
 *  and removes the whole horror-film association.
 *
 *  Two details carry it:
 *    - the bottom FADES rather than ending, so there is no second cut line
 *      where the shoulders stop;
 *    - the garment is cool and dark against her warm key-lit face, which is
 *      the contrast the reference render (mockups/nova-humanistic.png) uses
 *      to make skin read as skin.
 *
 *  This is a placeholder mass, not anatomy. The realistic body is a later
 *  phase; this one exists so the motion review is not of a floating head.
 */

import * as THREE from 'three';
import type { Head } from './head';

export interface Body {
  root: THREE.Group;
  update(t: number, breath: number): void;
  dispose(): void;
}

/** Head is normalised to 1 unit tall and centred, so these are all in
 *  head-heights: the numbers stay meaningful if the asset changes. */
const NECK_TOP = -0.24;         // tucked well inside the jaw, no seam
const NECK_BOTTOM = -0.56;
const SHOULDER_Y = -0.86;
// The frame bottom sits near y = -0.92, so the fade has to be well under
// way by then and finished just past it. Fading too early made the shoulders
// ghostly and detached her head from her body.
const FADE_FULL = -0.80;        // opaque above this
const FADE_GONE = -1.02;        // invisible below this

const GARMENT = new THREE.Color('#24455f');

export function createBody(head: Head): Body {
  const root = new THREE.Group();
  const disposables = new Set<THREE.Material | THREE.BufferGeometry>();

  const material = fadingMaterial(GARMENT, 0.82);
  disposables.add(material);

  // ONE lathed surface from the jaw to below the frame. Built out of three
  // separate primitives first — a cylinder, a capsule and a sphere — and no
  // amount of nudging stopped a seam or a gap opening between them as the
  // proportions changed. A single profile cannot come apart.
  // A bust, NOT a cone. The width has to arrive almost all at once at the
  // shoulder line and then stop: a profile that keeps widening all the way
  // down is radially a spinning top, and that is exactly what it looked like.
  const profile = [
    [0.125, NECK_TOP],          // tucked inside the jaw
    [0.130, -0.36],
    [0.152, -0.48],
    [0.205, NECK_BOTTOM],       // the neck meets the trapezius
    [0.360, -0.64],             // the slope out across the shoulders
    [0.520, SHOULDER_Y],        // shoulder line — most of the width is here
    [0.580, -0.76],             // the deltoid corner
    [0.600, -0.86],             // and then the arms drop straight
    [0.605, FADE_GONE],
  ].map(([r, y]) => new THREE.Vector2(r, y));

  const torso = new THREE.LatheGeometry(profile, 48);
  disposables.add(torso);
  const torsoMesh = new THREE.Mesh(torso, material);
  // A person is wider than they are deep; a lathe on its own is a bollard.
  torsoMesh.scale.set(1, 1, 0.66);
  root.add(torsoMesh);

  // The inside of a mouth. The scan models interior surfaces, and with
  // back-face culling on (needed so a parted mouth does not show the inside
  // of the skull) an open jaw would otherwise be a hole straight through to
  // the backdrop. A dark cavity is what is actually back there.
  const cavityGeo = new THREE.SphereGeometry(0.13, 16, 12);
  disposables.add(cavityGeo);
  const cavityMat = new THREE.MeshBasicMaterial({ color: '#150c10' });
  disposables.add(cavityMat);
  const cavity = new THREE.Mesh(cavityGeo, cavityMat);
  cavity.position.set(0, -0.17, 0.10);
  cavity.scale.set(1, 0.8, 0.9);
  head.root.add(cavity);

  return {
    root,
    update(t, breath) {
      // Breathing lives in the chest, not in a whole-body scale pulse — a
      // head that inflates is a balloon, a chest that rises is a person.
      // Widening the torso slightly and lifting it a hair is what a breath
      // looks like from the front.
      torsoMesh.scale.set(1 + breath * 0.004, 1, 0.66 + breath * 0.006);
      torsoMesh.position.y = breath * 0.006;
      // a barely-perceptible settle, so the silhouette is never dead still
      root.position.y = Math.sin(t * 0.21) * 0.004;
    },
    dispose() {
      cavity.removeFromParent();
      for (const d of disposables) d.dispose();
      disposables.clear();
    },
  };
}

/** Standard material that fades to nothing below the frame. Alpha rather
 *  than a colour ramp, because the backdrop behind her is a gradient with a
 *  halo — fading to a single colour would leave a visible ghost. */
function fadingMaterial(colour: THREE.Color, roughness: number) {
  const mat = new THREE.MeshStandardMaterial({
    color: colour,
    roughness,
    metalness: 0.02,
    transparent: true,
    side: THREE.DoubleSide,   // the neck tube is open-ended
  });
  mat.onBeforeCompile = shader => {
    shader.uniforms.uFadeFull = { value: FADE_FULL };
    shader.uniforms.uFadeGone = { value: FADE_GONE };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFadeY;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvFadeY = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying float vFadeY;\nuniform float uFadeFull;\nuniform float uFadeGone;')
      .replace('#include <dithering_fragment>',
        '#include <dithering_fragment>\ngl_FragColor.a *= smoothstep(uFadeGone, uFadeFull, vFadeY);');
  };
  return mat;
}
