/** Loading a head, and the seam that lets us swap the one we have for the
 *  one we want.
 *
 *  The head in the repo today is three.js's Face Cap example scan: a bald,
 *  male-presenting adult, which is nobody's idea of Nova. It is here because
 *  it carries the full 52-shape ARKit blendshape set, and blendshapes are
 *  what make a mouth sync and an eye blink possible at all. It is a stand-in
 *  for the MOTION, and the motion is what has to be proven first.
 *
 *  So nothing downstream of this file knows which head it is driving. A head
 *  is a URL, a map from the poses we use to whatever this asset calls them,
 *  and the names of a few nodes. Swapping in a sculpted head is a new
 *  descriptor, not a rewrite — and if that head is missing shapes, `has()`
 *  says so out loud rather than silently animating nothing.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/** The poses this view drives. Deliberately smaller than ARKit's 52: these
 *  are the ones with a job. */
export type MorphKey =
  // lids and brows
  | 'blinkL' | 'blinkR' | 'squintL' | 'squintR' | 'wideL' | 'wideR'
  | 'browInner' | 'browDownL' | 'browDownR' | 'browOuterL' | 'browOuterR'
  // gaze, for heads whose eyes are baked into the face mesh
  | 'lookUpL' | 'lookUpR' | 'lookDownL' | 'lookDownR'
  | 'lookInL' | 'lookInR' | 'lookOutL' | 'lookOutR'
  // mouth
  | 'jawOpen' | 'funnel' | 'pucker' | 'mouthClose'
  | 'smileL' | 'smileR' | 'frownL' | 'frownR'
  | 'stretchL' | 'stretchR' | 'pressL' | 'pressR'
  | 'upperUpL' | 'upperUpR' | 'lowerDownL' | 'lowerDownR'
  | 'dimpleL' | 'dimpleR' | 'shrugUpper'
  // cheeks — cheekSquint is the difference between a smile and a rictus
  | 'cheekSquintL' | 'cheekSquintR';

export interface HeadAsset {
  url: string;
  /** Our name for a pose, mapped to this asset's name for it. */
  morphs: Partial<Record<MorphKey, string>>;
  nodes: {
    /** Node carrying the morph-target mesh. */
    head: string;
    teeth?: string;
    /** Groups pivoted at the eyeball centres, if the asset provides them —
     *  rotating these is how gaze works when the eyes are separate meshes. */
    eyePivotL?: string;
    eyePivotR?: string;
  };
  /** Height in world units to normalise the head to, so framing does not
   *  depend on what units the artist happened to model in. */
  fitHeight: number;
}

/** three.js's Face Cap scan (examples/models/gltf/facecap.glb), by Bannaflak.
 *  A stand-in for the motion work — see the file header.
 *
 *  Its target names are exactly ARKit's, and it ships named pivot groups
 *  already sitting at the eyeball centres, so gaze is a group rotation. That
 *  matters more than it sounds: this asset's vertex positions are quantized
 *  (KHR_mesh_quantization), and translating that geometry corrupts it. */
export const FACECAP: HeadAsset = {
  url: '/models/facecap.glb',
  nodes: { head: 'head', teeth: 'teeth', eyePivotL: 'grp_eyeLeft', eyePivotR: 'grp_eyeRight' },
  fitHeight: 1,
  morphs: {
    blinkL: 'eyeBlink_L', blinkR: 'eyeBlink_R',
    squintL: 'eyeSquint_L', squintR: 'eyeSquint_R',
    wideL: 'eyeWide_L', wideR: 'eyeWide_R',
    browInner: 'browInnerUp',
    browDownL: 'browDown_L', browDownR: 'browDown_R',
    browOuterL: 'browOuterUp_L', browOuterR: 'browOuterUp_R',
    lookUpL: 'eyeLookUp_L', lookUpR: 'eyeLookUp_R',
    lookDownL: 'eyeLookDown_L', lookDownR: 'eyeLookDown_R',
    lookInL: 'eyeLookIn_L', lookInR: 'eyeLookIn_R',
    lookOutL: 'eyeLookOut_L', lookOutR: 'eyeLookOut_R',
    jawOpen: 'jawOpen', funnel: 'mouthFunnel', pucker: 'mouthPucker',
    mouthClose: 'mouthClose',
    smileL: 'mouthSmile_L', smileR: 'mouthSmile_R',
    frownL: 'mouthFrown_L', frownR: 'mouthFrown_R',
    stretchL: 'mouthStretch_L', stretchR: 'mouthStretch_R',
    pressL: 'mouthPress_L', pressR: 'mouthPress_R',
    upperUpL: 'mouthUpperUp_L', upperUpR: 'mouthUpperUp_R',
    lowerDownL: 'mouthLowerDown_L', lowerDownR: 'mouthLowerDown_R',
    dimpleL: 'mouthDimple_L', dimpleR: 'mouthDimple_R',
    shrugUpper: 'mouthShrugUpper',
    cheekSquintL: 'cheekSquint_L', cheekSquintR: 'cheekSquint_R',
  },
};

export interface Head {
  /** Normalised and centred: origin at the head's centre, `fitHeight` tall. */
  root: THREE.Group;
  meshes: THREE.Mesh[];
  eyeL: THREE.Object3D | null;
  eyeR: THREE.Object3D | null;
  /** The teeth, so the lower set can travel with the jaw. */
  teeth: THREE.Object3D | null;
  /** Bounding box of the head in root space, for placing hair and shoulders. */
  bounds: THREE.Box3;
  has(key: MorphKey): boolean;
  set(key: MorphKey, value: number): void;
  /** Zero every pose this head knows. Called once per frame before the
   *  animation systems write, so a pose that stops being driven relaxes
   *  instead of sticking. */
  clear(): void;
  dispose(): void;
}

let ktx2: KTX2Loader | null = null;

export async function loadHead(
  asset: HeadAsset,
  renderer: THREE.WebGLRenderer,
): Promise<Head> {
  const loader = new GLTFLoader();
  // The asset declares KHR_texture_basisu and EXT_meshopt_compression as
  // REQUIRED; without both of these attached GLTFLoader rejects at parse.
  if (!ktx2) {
    ktx2 = new KTX2Loader().setTranscoderPath('/basis/');
  }
  ktx2.detectSupport(renderer);
  loader.setKTX2Loader(ktx2);
  loader.setMeshoptDecoder(MeshoptDecoder);

  const gltf = await loader.loadAsync(asset.url);
  const scene = gltf.scene;

  const meshes: THREE.Mesh[] = [];
  scene.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });

  // Resolve the morph map against what this asset actually ships. A head
  // missing shapes is a real possibility once this seam is used in anger, so
  // it is reported rather than silently animating nothing.
  const named = scene.getObjectByName(asset.nodes.head);
  const morphMesh = (named && findMorphMesh(named)) ?? meshes.find(m => m.morphTargetInfluences?.length);
  const index = new Map<MorphKey, number>();
  const missing: MorphKey[] = [];
  if (morphMesh?.morphTargetDictionary) {
    const dict = morphMesh.morphTargetDictionary;
    for (const [key, name] of Object.entries(asset.morphs) as [MorphKey, string][]) {
      const i = dict[name];
      if (i === undefined) missing.push(key);
      else index.set(key, i);
    }
  }
  if (!morphMesh) {
    console.warn(`[identity] head "${asset.url}" has no morph targets — no expression, no lip sync`);
  } else if (missing.length) {
    console.warn(`[identity] head "${asset.url}" is missing ${missing.length} shape(s):`, missing.join(', '));
  }
  const influences = morphMesh?.morphTargetInfluences ?? null;

  // Every mesh in this asset shares one morph-bearing mesh's influences only
  // for the face; teeth and eyeballs are separate rigid meshes. They must be
  // carried along by the same parent, which the glb's own hierarchy does.
  const root = new THREE.Group();
  root.add(scene);

  // Normalise scale and centre. Done on the WRAPPER, never on the geometry:
  // quantized positions do not survive geometry.translate().
  const box = restBounds(scene);
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);
  const scale = size.y > 1e-6 ? asset.fitHeight / size.y : 1;
  scene.scale.multiplyScalar(scale);
  scene.position.sub(centre.multiplyScalar(scale));

  const bounds = restBounds(root);
  if (import.meta.env.DEV) {
    // Everything downstream (hair, body, framing) is derived from these. A
    // swapped head that renders wrong is almost always wrong here first.
    const s = new THREE.Vector3(); bounds.getSize(s);
    console.info(`[identity] "${asset.url}" fitted: size ${fmt(s)} bounds ${fmt(bounds.min)}..${fmt(bounds.max)}, ` +
      `${index.size} shapes, eyes ${asset.nodes.eyePivotL ? 'pivoted' : 'none'}`);
  }

  const disposables = new Set<THREE.Material | THREE.BufferGeometry | THREE.Texture>();
  for (const m of meshes) {
    disposables.add(m.geometry);
    for (const mat of materialsOf(m)) {
      disposables.add(mat);
      for (const tex of texturesOf(mat)) disposables.add(tex);
    }
  }

  return {
    root,
    meshes,
    eyeL: asset.nodes.eyePivotL ? scene.getObjectByName(asset.nodes.eyePivotL) ?? null : null,
    eyeR: asset.nodes.eyePivotR ? scene.getObjectByName(asset.nodes.eyePivotR) ?? null : null,
    teeth: asset.nodes.teeth ? scene.getObjectByName(asset.nodes.teeth) ?? null : null,
    bounds,
    has: key => index.has(key),
    set(key, value) {
      const i = index.get(key);
      if (i !== undefined && influences) influences[i] = value;
    },
    clear() {
      if (influences) influences.fill(0);
    },
    dispose() {
      for (const d of disposables) d.dispose();
      disposables.clear();
    },
  };
}

/** Release the shared transcoder. Separate from a head's dispose() because
 *  it is shared across every head this session ever loads. */
export function disposeHeadLoaders() {
  ktx2?.dispose();
  ktx2 = null;
}

/** Bounds of the head AT REST.
 *
 *  Not Box3.setFromObject: that expands the box to cover every morph target's
 *  extremes, and jawOpen alone throws vertices 0.43 units around. Using it
 *  made the derived skull a head taller than the actual skull, so the hair
 *  sat well above her crown like a helmet and the framing was wrong with it.
 *  Everything downstream wants the shape she actually has when still. */
function restBounds(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld));
    }
  });
  return box;
}

const fmt = (v: THREE.Vector3) =>
  `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;

function findMorphMesh(node: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  node.traverse(o => {
    const m = o as THREE.Mesh;
    if (!found && m.isMesh && m.morphTargetInfluences?.length) found = m;
  });
  return found;
}

const materialsOf = (m: THREE.Mesh): THREE.Material[] =>
  Array.isArray(m.material) ? m.material : [m.material];

function texturesOf(mat: THREE.Material): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
    if (v && (v as THREE.Texture).isTexture) out.push(v as THREE.Texture);
  }
  return out;
}
