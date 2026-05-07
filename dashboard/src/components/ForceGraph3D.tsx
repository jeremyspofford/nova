import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import ForceGraph3DLib from '3d-force-graph'
import {
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  BoxGeometry,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  Color,
  AdditiveBlending,
  Vector2,
  Vector3,
  Group,
  BufferGeometry,
  Float32BufferAttribute,
  PointsMaterial,
  Points,
  FrontSide,
  InstancedMesh,
  InstancedBufferAttribute,
  Object3D,
} from 'three'
// @ts-expect-error — three/examples not typed
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass'

// Shared uniform — update once per frame, all materials see the new value
const sharedUniforms = {
  uTime: { value: 0 },
  uDimOthers: { value: 0.0 },
}

// ── Types ────────────────────────────────────────────────────────────────────

interface GraphNode {
  id: string
  type: string
  importance: number
  cluster_id?: number
  cluster_label?: string
  source_type?: string
  // Full fields — only present from full endpoint or detail fetch
  content?: string
  activation?: number
  access_count?: number
}

interface GraphEdge {
  source: string
  target: string
  weight: number
  relation?: string
}

interface ClusterInfo {
  id: number
  label: string
  count: number
}

// ── Layout presets ────────────────────────────────────────────────────────────

export interface LayoutConfig {
  sphereRadius: number
  homeForce: number
  charge: number
  linkDist: number
  linkDistSpread: number
}

export const LAYOUT_PRESETS: Record<string, LayoutConfig & { label: string; description: string }> = {
  clustered: { label: 'Clustered', sphereRadius: 0, homeForce: 0, charge: -80, linkDist: 25, linkDistSpread: 40, description: 'Topic-clustered layout with spatial grouping' },
}

export const DEFAULT_LAYOUT = 'clustered'

export interface NeuralModeConfig {
  enabled: boolean
  breathingRate?: number      // Hz, default 0.02
  breathingAmplitude?: number // 0-1, default 0.05
  bloomStrength?: number      // default 0.2, range 0-1
  particlesAlways?: boolean   // override large-graph particle disable
}

export interface ForceGraph3DHandle {
  highlightNodes: (ids: string[]) => void
  pulseAll: (durationMs: number) => void
  fadeInNodes: (ids: string[]) => void
}

interface ForceGraph3DProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  clusters?: ClusterInfo[]
  selectedId: string | null
  onSelectNode: (id: string) => void
  onBackgroundClick?: () => void
  autoSpin?: boolean
  paused?: boolean
  bgColor?: string
  className?: string
  focusClusterId?: number | null
  focusClusterTs?: number
  focusNodeId?: string | null
  focusNodeTs?: number
  layoutPreset?: string
  neuralMode?: NeuralModeConfig
  showBackgroundStars?: boolean
  showInnerStars?: boolean
  showNebulae?: boolean
  showEdges?: boolean
  showCelestialObjects?: boolean
  showClusterGalaxies?: boolean
  showMilkyWay?: boolean
  showAsteroids?: boolean
  showSolarSystems?: boolean
  clusterSeparation?: number
  colorBy?: 'type' | 'source'
  onReady?: () => void
}

// ── Fibonacci sphere — evenly distributes cluster homes on a sphere ──────────

function fibonacciSphere(index: number, total: number, radius: number) {
  if (total <= 1) return { x: 0, y: 0, z: 0 }
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  const y = 1 - (index / (total - 1)) * 2
  const radiusAtY = Math.sqrt(1 - y * y)
  const theta = goldenAngle * index
  return {
    x: Math.cos(theta) * radiusAtY * radius,
    y: y * radius,
    z: Math.sin(theta) * radiusAtY * radius,
  }
}

// Module-level storage for cluster home positions (survives re-renders)
const clusterHomePositions = new Map<string, { x: number; y: number; z: number }>()

// ── Color helpers ─────────────────────────────────────────────────────────────

function getCSSColor(varName: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  if (!raw) return '#71717a'
  const parts = raw.split(' ').map(Number)
  if (parts.length !== 3) return '#71717a'
  return '#' + parts.map(n => n.toString(16).padStart(2, '0')).join('')
}

function getAccentColor(): string {
  return getCSSColor('--accent-500')
}

// ── Color mapping ────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  fact:       '#60a5fa',
  entity:     '#2dd4bf',
  preference: '#34d399',
  procedure:  '#a1a1aa',
  self_model: '#818cf8',
  episode:    '#fbbf24',
  schema:     '#f87171',
  goal:       '#c084fc',
}
const DEFAULT_COLOR = '#71717a'

const SOURCE_COLORS: Record<string, string> = {
  chat: '#60a5fa',           // blue — personal conversations
  consolidation: '#a78bfa',  // purple — synthesized knowledge
  intel: '#f97316',          // orange — intel feeds
  knowledge: '#34d399',      // green — knowledge crawl
  self_reflection: '#818cf8',// indigo — self-model
  pipeline: '#f87171',       // red — pipeline extraction
  tool: '#fbbf24',           // amber — tool output
  cortex: '#e879f9',         // pink — cortex
  external: '#94a3b8',       // slate — external
}

const NEURAL_TYPE_COLORS: Record<string, string> = {
  fact:       '#3b82f6',
  entity:     '#14b8a6',
  preference: '#10b981',
  procedure:  '#a1a1aa',
  self_model: '#6366f1',
  episode:    '#f59e0b',
  schema:     '#ef4444',
  goal:       '#a855f7',
  topic:      '#06b6d4',
}

// Distinct cluster colors for full-graph mode
const CLUSTER_COLORS = [
  '#818cf8', '#60a5fa', '#2dd4bf', '#34d399', '#fbbf24',
  '#f87171', '#c084fc', '#fb923c', '#a3e635', '#22d3ee',
  '#e879f9', '#f472b6', '#38bdf8', '#4ade80', '#facc15',
  '#a78bfa', '#67e8f9', '#fca5a5', '#86efac', '#fde68a',
]

function getNodeColor(node: GraphNode, useCluster: boolean, neural?: boolean, colorBy?: 'type' | 'source'): string {
  if (colorBy === 'source' && node.source_type) {
    return SOURCE_COLORS[node.source_type] ?? '#6b7280'
  }
  if (useCluster && node.cluster_id != null) {
    return CLUSTER_COLORS[node.cluster_id % CLUSTER_COLORS.length]
  }
  if (neural) {
    return NEURAL_TYPE_COLORS[node.type] ?? TYPE_COLORS[node.type] ?? DEFAULT_COLOR
  }
  return TYPE_COLORS[node.type] ?? DEFAULT_COLOR
}

// ── Glow sprite texture (cached) ─────────────────────────────────────────────

let glowTextureCache: CanvasTexture | null = null

function getGlowTexture(): CanvasTexture {
  if (glowTextureCache) return glowTextureCache
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255,255,255,0.6)')
  gradient.addColorStop(0.3, 'rgba(255,255,255,0.15)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
  glowTextureCache = new CanvasTexture(canvas)
  return glowTextureCache
}

// ── Instanced star glow shader ───────────────────────────────────────────────
// All star nodes render via a single InstancedMesh (1-2 draw calls total).
// Per-node data (color, importance, birth time, highlight) lives in
// InstancedBufferAttributes instead of per-material uniforms.

const instancedStarVertexShader = /* glsl */ `
  // Per-instance attributes
  attribute vec3 aColor;
  attribute float aImportance;
  attribute float aBirthTime;
  attribute float aHighlightStart;

  uniform float uTime;

  varying float vFacing;
  varying vec3 vColor;
  varying float vImportance;
  varying float vBirthTime;
  varying float vHighlightStart;
  varying float vIsHighlighted;

  void main() {
    // Apply instance transform (position + scale from instanceMatrix)
    vec4 worldPos = instanceMatrix * vec4(position, 1.0);
    vec4 mvPos = modelViewMatrix * worldPos;

    // Normal — for uniform scaling, normalMatrix is sufficient
    vec3 transformedNormal = normalize(normalMatrix * normal);
    vec3 viewDir = normalize(-mvPos.xyz);
    vFacing = dot(transformedNormal, viewDir);

    // Determine if this node is currently highlighted
    float highlightAge = uTime - aHighlightStart;
    vIsHighlighted = (aHighlightStart > 0.0 && highlightAge < 5.0) ? 1.0 : 0.0;

    // Pass per-instance data to fragment
    vColor = aColor;
    vImportance = aImportance;
    vBirthTime = aBirthTime;
    vHighlightStart = aHighlightStart;

    gl_Position = projectionMatrix * mvPos;
  }
`

const instancedStarFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uDimOthers;

  varying float vFacing;
  varying vec3 vColor;
  varying float vImportance;
  varying float vBirthTime;
  varying float vHighlightStart;
  varying float vIsHighlighted;

  void main() {
    // Soft radial falloff — facing=1 at center, 0 at rim
    float glow = pow(max(vFacing, 0.0), 1.8);

    // Bright white-hot center point
    float center = pow(max(vFacing, 0.0), 8.0);

    // Breathing animation — importance-based phase offset
    float breathe = 1.0 + sin(uTime * 0.4 + vImportance * 6.28) * 0.08;

    // Birth fade-in (1 second)
    float age = uTime - vBirthTime;
    float birthFade = clamp(age, 0.0, 1.0);

    // Highlight pulse (fades out over 5.0 seconds)
    float highlightAge = uTime - vHighlightStart;
    float highlight = vHighlightStart > 0.0
      ? max(0.0, 1.0 - highlightAge / 5.0) * 0.7
      : 0.0;

    // Combine: colored glow + white center
    float opacity = 0.3 + vImportance * 0.7;
    float brightness = opacity * breathe;
    vec3 col = vColor * glow * brightness + vec3(1.0) * center * brightness * 0.6;
    // Highlight uses amber to look like neural activation
    vec3 amberHighlight = vec3(0.98, 0.75, 0.14); // #FBBF24 amber-400
    col += amberHighlight * highlight;

    // Dim non-highlighted nodes when activation cascade is running
    if (uDimOthers > 0.0 && vIsHighlighted < 0.5) {
      float dimFactor = mix(1.0, 0.2, uDimOthers);
      col *= dimFactor;
    }

    // Alpha: glow fades to transparent at rim
    float alpha = glow * opacity * birthFade + center * 0.5 * birthFade;
    alpha = clamp(alpha, 0.0, 1.0);

    gl_FragColor = vec4(col, alpha);
  }
`

// ── InstancedMesh builder ────────────────────────────────────────────────────
// Creates a single InstancedMesh for all star nodes. Returns the mesh and a
// map from node ID to instance index for per-node attribute updates.

function buildStarInstances(
  nodes: any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  geometry: SphereGeometry,
  clusters: ClusterInfo[] | undefined,
  neuralEnabled: boolean,
  colorBy?: 'type' | 'source',
): { mesh: InstancedMesh; nodeIndexMap: Map<string, number> } {
  const count = nodes.length
  if (count === 0) {
    return { mesh: new InstancedMesh(geometry, new MeshBasicMaterial(), 0), nodeIndexMap: new Map() }
  }

  const useClusterColors = (clusters?.length ?? 0) > 0

  // Per-instance attribute arrays
  const colors = new Float32Array(count * 3)
  const importances = new Float32Array(count)
  const birthTimes = new Float32Array(count)
  const highlightStarts = new Float32Array(count)

  const nodeIndexMap = new Map<string, number>()
  const dummy = new Object3D()
  const tmpColor = new Color()
  const now = sharedUniforms.uTime.value

  for (let i = 0; i < count; i++) {
    const node = nodes[i]
    nodeIndexMap.set(node.id, i)

    const importance = node.importance ?? 0
    const color = getNodeColor(node, useClusterColors, neuralEnabled, colorBy)

    tmpColor.set(color)
    colors[i * 3] = tmpColor.r
    colors[i * 3 + 1] = tmpColor.g
    colors[i * 3 + 2] = tmpColor.b

    importances[i] = importance
    birthTimes[i] = now
    highlightStarts[i] = 0
  }

  // Clone geometry and add instance attributes
  const instanceGeo = geometry.clone()
  instanceGeo.setAttribute('aColor', new InstancedBufferAttribute(colors, 3))
  instanceGeo.setAttribute('aImportance', new InstancedBufferAttribute(importances, 1))
  instanceGeo.setAttribute('aBirthTime', new InstancedBufferAttribute(birthTimes, 1))
  instanceGeo.setAttribute('aHighlightStart', new InstancedBufferAttribute(highlightStarts, 1))

  const material = new ShaderMaterial({
    uniforms: { uTime: sharedUniforms.uTime, uDimOthers: sharedUniforms.uDimOthers },
    vertexShader: instancedStarVertexShader,
    fragmentShader: instancedStarFragmentShader,
    transparent: true,
    side: FrontSide,
    depthWrite: false,
  })

  const mesh = new InstancedMesh(instanceGeo, material, count)

  // Set instance matrices
  for (let i = 0; i < count; i++) {
    const node = nodes[i]
    const importance = node.importance ?? 0
    const radius = 2 + importance * 6
    dummy.position.set(node.x ?? 0, node.y ?? 0, node.z ?? 0)
    dummy.scale.setScalar(radius)
    dummy.updateMatrix()
    mesh.setMatrixAt(i, dummy.matrix)
  }
  mesh.instanceMatrix.needsUpdate = true
  mesh.frustumCulled = false // Graph may exceed frustum during animation

  return { mesh, nodeIndexMap }
}

// ── Position sync — update instance matrices from force-graph layout ─────────

const _syncDummy = new Object3D()

function syncInstancePositions(
  mesh: InstancedMesh,
  nodes: any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  nodeIndexMap: Map<string, number>,
) {
  for (const node of nodes) {
    const i = nodeIndexMap.get(node.id)
    if (i === undefined) continue
    const importance = node.importance ?? 0
    const radius = 2 + importance * 6
    _syncDummy.position.set(node.x ?? 0, node.y ?? 0, node.z ?? 0)
    _syncDummy.scale.setScalar(radius)
    _syncDummy.updateMatrix()
    mesh.setMatrixAt(i, _syncDummy.matrix)
  }
  mesh.instanceMatrix.needsUpdate = true
}

// ── Node label texture ───────────────────────────────────────────────────────

const labelTextureCache = new Map<string, CanvasTexture>()

function makeNodeLabelTexture(text: string, color: string): CanvasTexture {
  const key = `${text}|${color}`
  const cached = labelTextureCache.get(key)
  if (cached) return cached

  const canvas = document.createElement('canvas')
  const w = 512
  const h = 64
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, w, h)

  // Topic labels: clean, readable, concise
  const label = text.length > 28 ? text.slice(0, 26) + '...' : text

  ctx.font = '600 22px system-ui'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // Measure text for background pill
  const metrics = ctx.measureText(label)
  const textW = metrics.width
  const padX = 18
  const padY = 8
  const pillW = textW + padX * 2
  const pillH = 28 + padY * 2
  const pillX = (w - pillW) / 2
  const pillY = (h - pillH) / 2

  // Semi-transparent dark pill with slight teal tint
  ctx.fillStyle = 'rgba(8, 45, 42, 0.75)'
  ctx.beginPath()
  ctx.roundRect(pillX, pillY, pillW, pillH, 10)
  ctx.fill()

  // Subtle border in type color
  ctx.strokeStyle = color
  ctx.globalAlpha = 0.4
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.roundRect(pillX, pillY, pillW, pillH, 10)
  ctx.stroke()

  // Dark outline to separate from bloom
  ctx.globalAlpha = 1
  ctx.strokeStyle = 'rgba(8, 45, 42, 0.9)'
  ctx.lineWidth = 4
  ctx.lineJoin = 'round'
  ctx.strokeText(label, w / 2, h / 2)

  // Bright text — topic names should be clearly readable
  ctx.fillStyle = '#e4e4e7'
  ctx.fillText(label, w / 2, h / 2)

  const tex = new CanvasTexture(canvas)
  labelTextureCache.set(key, tex)
  return tex
}


// ── Galaxy starfield ────────────────────────────────────────────────────────

function makeNebulaTexture(r: number, g: number, b: number): CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size; canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, size, size)

  const cx = size / 2, cy = size / 2

  // Main soft glow
  const g1 = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.45)
  g1.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.5)`)
  g1.addColorStop(0.4, `rgba(${r}, ${g}, ${b}, 0.15)`)
  g1.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
  ctx.fillStyle = g1
  ctx.fillRect(0, 0, size, size)

  // Asymmetric secondary highlight
  const g2 = ctx.createRadialGradient(cx + 40, cy - 30, 0, cx + 40, cy - 30, size * 0.25)
  const r2 = Math.min(255, r + 60), g2c = Math.min(255, g + 50), b2 = Math.min(255, b + 80)
  g2.addColorStop(0, `rgba(${r2}, ${g2c}, ${b2}, 0.25)`)
  g2.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, 0.05)`)
  g2.addColorStop(1, `rgba(0, 0, 0, 0)`)
  ctx.fillStyle = g2
  ctx.fillRect(0, 0, size, size)

  return new CanvasTexture(canvas)
}

function makeGalaxyTexture(): CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size; canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, size, size)

  // Elliptical galaxy — scale Y to flatten
  ctx.save()
  ctx.translate(size / 2, size / 2)
  ctx.scale(1, 0.35)

  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, size / 3)
  grad.addColorStop(0, 'rgba(255, 245, 230, 0.7)')
  grad.addColorStop(0.3, 'rgba(180, 160, 220, 0.25)')
  grad.addColorStop(0.7, 'rgba(80, 100, 180, 0.08)')
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(0, 0, size / 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  return new CanvasTexture(canvas)
}

// ── Celestial object textures ────────────────────────────────────────────────

function makePlanetTexture(r: number, g: number, b: number, atmosphere = false): CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2, cy = size / 2, rad = size * 0.38

  if (atmosphere) {
    const atm = ctx.createRadialGradient(cx - rad * 0.2, cy - rad * 0.1, rad * 0.9, cx, cy, rad * 1.4)
    atm.addColorStop(0, `rgba(${Math.min(255, r + 80)},${Math.min(255, g + 80)},${Math.min(255, b + 100)},0.12)`)
    atm.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = atm
    ctx.beginPath(); ctx.arc(cx, cy, rad * 1.4, 0, Math.PI * 2); ctx.fill()
  }

  const bodyGrad = ctx.createRadialGradient(cx - rad * 0.35, cy - rad * 0.35, 0, cx, cy, rad)
  bodyGrad.addColorStop(0, `rgba(${Math.min(255, r + 60)},${Math.min(255, g + 60)},${Math.min(255, b + 60)},1)`)
  bodyGrad.addColorStop(0.5, `rgba(${r},${g},${b},1)`)
  bodyGrad.addColorStop(0.8, `rgba(${Math.floor(r * 0.4)},${Math.floor(g * 0.4)},${Math.floor(b * 0.4)},1)`)
  bodyGrad.addColorStop(1, `rgba(${Math.floor(r * 0.15)},${Math.floor(g * 0.15)},${Math.floor(b * 0.15)},0.9)`)
  ctx.fillStyle = bodyGrad
  ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill()

  // Subtle color banding
  ctx.save(); ctx.globalAlpha = 0.08
  ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.clip()
  for (let i = 0; i < 3; i++) {
    const y = cy - rad * 0.3 + i * rad * 0.35
    const band = ctx.createLinearGradient(cx - rad, y, cx + rad, y + 4)
    band.addColorStop(0, 'transparent')
    band.addColorStop(0.3, `rgba(${Math.min(255, r + 40)},${Math.min(255, g + 30)},${Math.min(255, b + 20)},0.5)`)
    band.addColorStop(0.7, `rgba(${Math.min(255, r + 40)},${Math.min(255, g + 30)},${Math.min(255, b + 20)},0.3)`)
    band.addColorStop(1, 'transparent')
    ctx.fillStyle = band; ctx.fillRect(cx - rad, y, rad * 2, 4)
  }
  ctx.restore()
  return new CanvasTexture(canvas)
}

function makeRingedPlanetTexture(r: number, g: number, b: number): CanvasTexture {
  const size = 192
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2, cy = size / 2, planetRad = size * 0.2

  // Ring (behind planet on bottom half)
  ctx.save(); ctx.translate(cx, cy); ctx.scale(1, 0.35); ctx.rotate(-0.15)
  const ringGrad = ctx.createRadialGradient(0, 0, planetRad * 1.3, 0, 0, planetRad * 2.8)
  ringGrad.addColorStop(0, 'rgba(0,0,0,0)')
  ringGrad.addColorStop(0.15, `rgba(${Math.min(255, r + 40)},${Math.min(255, g + 30)},${Math.min(255, b + 20)},0.5)`)
  ringGrad.addColorStop(0.3, `rgba(${r},${g},${b},0.6)`)
  ringGrad.addColorStop(0.5, `rgba(${Math.min(255, r + 60)},${Math.min(255, g + 50)},${Math.min(255, b + 30)},0.4)`)
  ringGrad.addColorStop(0.7, `rgba(${r},${g},${b},0.3)`)
  ringGrad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = ringGrad
  ctx.beginPath(); ctx.arc(0, 0, planetRad * 2.8, 0, Math.PI * 2); ctx.fill()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.beginPath(); ctx.arc(0, 0, planetRad * 1.3, 0, Math.PI * 2); ctx.fill()
  ctx.globalCompositeOperation = 'source-over'
  ctx.restore()

  // Planet body
  const bodyGrad = ctx.createRadialGradient(cx - planetRad * 0.3, cy - planetRad * 0.3, 0, cx, cy, planetRad)
  bodyGrad.addColorStop(0, `rgba(${Math.min(255, r + 50)},${Math.min(255, g + 50)},${Math.min(255, b + 50)},1)`)
  bodyGrad.addColorStop(0.6, `rgba(${r},${g},${b},1)`)
  bodyGrad.addColorStop(1, `rgba(${Math.floor(r * 0.3)},${Math.floor(g * 0.3)},${Math.floor(b * 0.3)},1)`)
  ctx.fillStyle = bodyGrad
  ctx.beginPath(); ctx.arc(cx, cy, planetRad, 0, Math.PI * 2); ctx.fill()
  return new CanvasTexture(canvas)
}

function makeSunTexture(r: number, g: number, b: number): CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const corona = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  corona.addColorStop(0, 'rgba(255,255,255,0.9)')
  corona.addColorStop(0.08, 'rgba(255,255,240,0.7)')
  corona.addColorStop(0.2, `rgba(${r},${g},${b},0.4)`)
  corona.addColorStop(0.5, `rgba(${r},${g},${b},0.08)`)
  corona.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = corona; ctx.fillRect(0, 0, size, size)
  return new CanvasTexture(canvas)
}

function makeBlackHoleTexture(): CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2, cy = size / 2

  // Teal accretion disk
  ctx.save(); ctx.translate(cx, cy); ctx.scale(1, 0.4); ctx.rotate(0.2)
  const disk = ctx.createRadialGradient(0, 0, size * 0.08, 0, 0, size * 0.45)
  disk.addColorStop(0, 'rgba(0,0,0,0)')
  disk.addColorStop(0.2, 'rgba(25,168,158,0.0)')
  disk.addColorStop(0.32, 'rgba(25,168,158,0.6)')
  disk.addColorStop(0.42, 'rgba(180,240,235,0.5)')
  disk.addColorStop(0.48, 'rgba(255,255,255,0.45)')
  disk.addColorStop(0.55, 'rgba(25,168,158,0.6)')
  disk.addColorStop(0.7, 'rgba(25,168,158,0.15)')
  disk.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = disk
  ctx.beginPath(); ctx.arc(0, 0, size * 0.45, 0, Math.PI * 2); ctx.fill()
  // Gravitational lensing highlight
  const lens = ctx.createRadialGradient(size * 0.12, -size * 0.02, size * 0.15, 0, 0, size * 0.42)
  lens.addColorStop(0, 'rgba(100,220,210,0.3)')
  lens.addColorStop(0.5, 'rgba(25,168,158,0.08)')
  lens.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = lens
  ctx.beginPath(); ctx.arc(0, 0, size * 0.42, 0, Math.PI * 2); ctx.fill()
  ctx.restore()

  // Event horizon — solid black core, nothing escapes
  const dark = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.18)
  dark.addColorStop(0, 'rgba(0,0,0,1)')
  dark.addColorStop(0.6, 'rgba(0,0,0,1)')
  dark.addColorStop(0.85, 'rgba(0,0,0,0.9)')
  dark.addColorStop(1, 'rgba(0,0,0,0.3)')
  ctx.fillStyle = dark
  ctx.beginPath(); ctx.arc(cx, cy, size * 0.18, 0, Math.PI * 2); ctx.fill()
  return new CanvasTexture(canvas)
}

function makeClusterHaloTexture(r: number, g: number, b: number): CanvasTexture {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(size * 0.45, size * 0.48, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, `rgba(${r},${g},${b},0.45)`)
  grad.addColorStop(0.3, `rgba(${r},${g},${b},0.18)`)
  grad.addColorStop(0.6, `rgba(${r},${g},${b},0.06)`)
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = grad; ctx.fillRect(0, 0, size, size)
  return new CanvasTexture(canvas)
}

// Store orbiting planet sprites so the tick loop can animate them
const orbitingPlanets: { sprite: Sprite; cx: number; cy: number; cz: number; radius: number; speed: number; phase: number; tilt: number }[] = []

function createStarfield(options: { bgStars: boolean; innerStars: boolean; nebulae: boolean; celestialObjects: boolean; milkyWay: boolean; asteroids: boolean; solarSystems: boolean }): Group {
  orbitingPlanets.length = 0
  const group = new Group()
  group.name = 'starfield'

  // ── Nebulae — distant color clouds ──
  if (options.nebulae) {
  const nebulae = [
    { x: 2500,  y: 1200,  z: -2000, s: 800,  r: 100, g: 60,  b: 180, op: 0.12 },
    { x: -2200, y: -1500, z: 2400,  s: 700,  r: 40,  g: 80,  b: 160, op: 0.10 },
    { x: 1200,  y: 2800,  z: 1600,  s: 600,  r: 160, g: 40,  b: 80,  op: 0.07 },
    { x: -3000, y: 800,   z: -1200, s: 900,  r: 30,  g: 100, b: 120, op: 0.08 },
    { x: 400,   y: -2400, z: -2800, s: 500,  r: 140, g: 100, b: 40,  op: 0.06 },
    { x: 3500,  y: -600,  z: 1800,  s: 650,  r: 80,  g: 40,  b: 140, op: 0.07 },
    { x: -1800, y: 3000,  z: -800,  s: 550,  r: 50,  g: 120, b: 100, op: 0.06 },
    { x: 800,   y: -3200, z: 2200,  s: 750,  r: 120, g: 60,  b: 60,  op: 0.05 },
  ]

  for (const n of nebulae) {
    const tex = makeNebulaTexture(n.r, n.g, n.b)
    const mat = new SpriteMaterial({
      map: tex, transparent: true, opacity: n.op,
      blending: AdditiveBlending, depthWrite: false,
    })
    const sprite = new Sprite(mat)
    sprite.position.set(n.x, n.y, n.z)
    sprite.scale.set(n.s, n.s, 1)
    group.add(sprite)
  }

  // ── Distant galaxies — tiny elliptical blobs ──
  const galaxies = [
    { x: 4000,  y: 2000,  z: -3000, w: 90,  h: 30, rot: 0.3 },
    { x: -3500, y: -1500, z: 3500,  w: 70,  h: 22, rot: -0.5 },
    { x: 2000,  y: -3500, z: -2500, w: 80,  h: 28, rot: 0.8 },
    { x: -1500, y: 4000,  z: -2000, w: 60,  h: 20, rot: -0.2 },
    { x: 5000,  y: -800,  z: 1500,  w: 50,  h: 18, rot: 0.6 },
    { x: -4500, y: 1200,  z: -3000, w: 65,  h: 24, rot: -0.4 },
  ]

  for (const g of galaxies) {
    const tex = makeGalaxyTexture()
    const mat = new SpriteMaterial({
      map: tex, transparent: true, opacity: 0.5,
      blending: AdditiveBlending, depthWrite: false,
    })
    mat.rotation = g.rot
    const sprite = new Sprite(mat)
    sprite.position.set(g.x, g.y, g.z)
    sprite.scale.set(g.w, g.h, 1)
    group.add(sprite)
  }
  } // end nebulae

  // ── Celestial objects — planets, suns, black hole ──
  if (options.celestialObjects) {
    const celestials: { tex: CanvasTexture; x: number; y: number; z: number; s: number; op: number; additive: boolean }[] = [
      // Planets (normal blending — solid look) — scattered far from center
      { tex: makePlanetTexture(180, 140, 60, true),  x: 3500,  y: -1200, z: -2800, s: 100, op: 0.55, additive: false }, // gas giant
      { tex: makePlanetTexture(100, 120, 140),        x: -3200, y: 1800,  z: 2200,  s: 40,  op: 0.45, additive: false }, // rocky
      { tex: makePlanetTexture(140, 200, 200, true),  x: 1800,  y: 3500,  z: -3200, s: 55,  op: 0.5,  additive: false }, // ice world
      { tex: makeRingedPlanetTexture(190, 150, 80),   x: -2800, y: -2000, z: -3500, s: 110, op: 0.55, additive: false }, // ringed saturn
      { tex: makePlanetTexture(200, 100, 80, true),   x: 4200,  y: 600,   z: 1800,  s: 70,  op: 0.45, additive: false }, // mars-like
      { tex: makePlanetTexture(60, 80, 160),          x: -1500, y: -3800, z: -1200, s: 85,  op: 0.5,  additive: false }, // neptune-like
      { tex: makeRingedPlanetTexture(140, 160, 180),  x: 2500,  y: -3000, z: 2800,  s: 95,  op: 0.5,  additive: false }, // ice ringed
      { tex: makePlanetTexture(220, 180, 120),        x: -4000, y: 2500,  z: -800,  s: 45,  op: 0.4,  additive: false }, // desert world
      // Suns (additive blending — glow through bloom)
      { tex: makeSunTexture(255, 230, 150), x: 4500,  y: 1800,  z: 3200,  s: 150, op: 0.4, additive: true }, // yellow-white
      { tex: makeSunTexture(220, 80, 40),   x: -4000, y: -2800, z: 1500,  s: 60,  op: 0.35, additive: true }, // red dwarf
      { tex: makeSunTexture(180, 200, 255), x: -2000, y: 4200,  z: -2500, s: 90,  op: 0.3, additive: true }, // blue giant
    ]

    for (const c of celestials) {
      const mat = new SpriteMaterial({
        map: c.tex, transparent: true, opacity: c.op,
        blending: c.additive ? AdditiveBlending : undefined,
        depthWrite: false,
      })
      const sprite = new Sprite(mat)
      sprite.position.set(c.x, c.y, c.z)
      sprite.scale.set(c.s, c.s, 1)
      group.add(sprite)
    }

    // Black hole — two layers for proper occlusion
    // Layer 1: opaque event horizon core (blocks stars behind it)
    const bhCoreCanvas = document.createElement('canvas')
    bhCoreCanvas.width = bhCoreCanvas.height = 128
    const bhCtx = bhCoreCanvas.getContext('2d')!
    const bhGrad = bhCtx.createRadialGradient(64, 64, 0, 64, 64, 64)
    bhGrad.addColorStop(0, 'rgba(0,0,0,1)')
    bhGrad.addColorStop(0.5, 'rgba(0,0,0,1)')
    bhGrad.addColorStop(0.75, 'rgba(0,0,0,0.8)')
    bhGrad.addColorStop(1, 'rgba(0,0,0,0)')
    bhCtx.fillStyle = bhGrad
    bhCtx.beginPath(); bhCtx.arc(64, 64, 64, 0, Math.PI * 2); bhCtx.fill()
    const bhCoreMat = new SpriteMaterial({
      map: new CanvasTexture(bhCoreCanvas), transparent: true, opacity: 1.0,
      depthWrite: true,
    })
    const bhCore = new Sprite(bhCoreMat)
    bhCore.position.set(-3000, 1200, -5000)
    bhCore.scale.set(60, 60, 1)
    group.add(bhCore)

    // Layer 2: accretion disk glow (additive blending adds glow around the core)
    const bhDiskMat = new SpriteMaterial({
      map: makeBlackHoleTexture(), transparent: true, opacity: 0.9,
      blending: AdditiveBlending, depthWrite: false,
    })
    const bhDisk = new Sprite(bhDiskMat)
    bhDisk.position.set(-3000, 1200, -5000)
    bhDisk.scale.set(200, 200, 1)
    group.add(bhDisk)
  }

  // ── Solar systems — planets orbiting around suns ──
  if (options.solarSystems && options.celestialObjects) {
    const solarSystems = [
      { // Yellow-white sun system
        cx: 4500, cy: 1800, cz: 3200,
        planets: [
          { r: 160, g: 100, b: 60,  size: 25, orbit: 220, speed: 0.25, tilt: -0.15 },
          { r: 8,   g: 150, b: 180, size: 30, orbit: 320, speed: 0.15, tilt: 0.2 },
          { r: 180, g: 140, b: 80,  size: 45, orbit: 450, speed: 0.08, tilt: -0.1, ring: true },
          { r: 100, g: 160, b: 200, size: 28, orbit: 600, speed: 0.04, tilt: 0.3 },
        ],
      },
      { // Red dwarf system — fewer, closer planets
        cx: -4000, cy: -2800, cz: 1500,
        planets: [
          { r: 140, g: 80,  b: 60,  size: 22, orbit: 80,  speed: 0.35, tilt: 0.1 },
          { r: 80,  g: 120, b: 140, size: 28, orbit: 140, speed: 0.2,  tilt: -0.2 },
          { r: 200, g: 160, b: 100, size: 20, orbit: 200, speed: 0.12, tilt: 0.15 },
        ],
      },
      { // Blue giant system — large orbits, big planets
        cx: -2000, cy: 4200, cz: -2500,
        planets: [
          { r: 60,  g: 100, b: 180, size: 35, orbit: 300, speed: 0.1,  tilt: 0.25 },
          { r: 140, g: 180, b: 200, size: 50, orbit: 500, speed: 0.06, tilt: -0.15, ring: true },
          { r: 180, g: 120, b: 80,  size: 25, orbit: 180, speed: 0.2,  tilt: 0.1 },
        ],
      },
    ]

    for (const sys of solarSystems) {
      for (const p of sys.planets) {
        const tex = p.ring
          ? makeRingedPlanetTexture(p.r, p.g, p.b)
          : makePlanetTexture(p.r, p.g, p.b)
        const mat = new SpriteMaterial({
          map: tex, transparent: true, opacity: 0.8,
          blending: AdditiveBlending, depthWrite: false,
        })
        const sprite = new Sprite(mat)
        sprite.scale.set(p.size, p.size, 1)
        // Initial position — will be animated in tick loop
        sprite.position.set(sys.cx + p.orbit, sys.cy, sys.cz)
        group.add(sprite)
        orbitingPlanets.push({
          sprite, cx: sys.cx, cy: sys.cy, cz: sys.cz,
          radius: p.orbit, speed: p.speed,
          phase: Math.random() * Math.PI * 2,
          tilt: p.tilt,
        })
      }
    }
  }

  // ── Deep-field stars — static backdrop ──
  if (options.bgStars) {
    // Layer 1: primary deep stars — constant pixel size, always visible
    const deepCount = 6000
    const deepPos = new Float32Array(deepCount * 3)
    const deepCol = new Float32Array(deepCount * 3)

    for (let i = 0; i < deepCount; i++) {
      const r = 2000 + Math.random() * 8000
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      deepPos[i * 3]     = r * Math.sin(phi) * Math.cos(theta)
      deepPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      deepPos[i * 3 + 2] = r * Math.cos(phi)

      const t = Math.random()
      if (t < 0.6) {
        deepCol[i * 3] = 0.7 + Math.random() * 0.3
        deepCol[i * 3 + 1] = 0.75 + Math.random() * 0.25
        deepCol[i * 3 + 2] = 1.0
      } else if (t < 0.8) {
        deepCol[i * 3] = 1.0
        deepCol[i * 3 + 1] = 0.85 + Math.random() * 0.15
        deepCol[i * 3 + 2] = 0.6 + Math.random() * 0.2
      } else {
        deepCol[i * 3] = 0.4 + Math.random() * 0.2
        deepCol[i * 3 + 1] = 0.5 + Math.random() * 0.2
        deepCol[i * 3 + 2] = 1.0
      }
    }

    const deepGeo = new BufferGeometry()
    deepGeo.setAttribute('position', new Float32BufferAttribute(deepPos, 3))
    deepGeo.setAttribute('color', new Float32BufferAttribute(deepCol, 3))
    const deepStars = new Points(deepGeo, new PointsMaterial({
      size: 2.0, vertexColors: true, transparent: true, opacity: 0.7,
      sizeAttenuation: false, depthTest: false, depthWrite: false,
    }))
    deepStars.renderOrder = -1
    group.add(deepStars)

    // Layer 2: ultra-distant faint stars — fills the void when zoomed out
    const farCount = 8000
    const farPos = new Float32Array(farCount * 3)
    for (let i = 0; i < farCount; i++) {
      const r = 8000 + Math.random() * 16000
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      farPos[i * 3]     = r * Math.sin(phi) * Math.cos(theta)
      farPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      farPos[i * 3 + 2] = r * Math.cos(phi)
    }
    const farGeo = new BufferGeometry()
    farGeo.setAttribute('position', new Float32BufferAttribute(farPos, 3))
    const farStars = new Points(farGeo, new PointsMaterial({
      size: 1.5, color: 0x9999cc, transparent: true, opacity: 0.45,
      sizeAttenuation: false, depthTest: false, depthWrite: false,
    }))
    farStars.renderOrder = -2
    group.add(farStars)

  }

  // ── Milky Way band — flattened disc of stars creating a galactic plane ──
  if (options.milkyWay) {
    const milkyCount = 6000
    const milkyPos = new Float32Array(milkyCount * 3)
    const milkyCol = new Float32Array(milkyCount * 3)
    for (let i = 0; i < milkyCount; i++) {
      const r = 2000 + Math.random() * 14000
      const theta = Math.random() * Math.PI * 2
      // Flatten to a disc with gaussian-ish y falloff — denser near the plane
      const ySpread = (Math.random() + Math.random() + Math.random() - 1.5) * 400
      milkyPos[i * 3]     = r * Math.cos(theta)
      milkyPos[i * 3 + 1] = ySpread
      milkyPos[i * 3 + 2] = r * Math.sin(theta)
      // Warm white to pale blue, brighter near center
      const centerFade = Math.min(1, r / 5000)
      const warmth = Math.random()
      milkyCol[i * 3]     = (0.7 + warmth * 0.3) * (0.6 + centerFade * 0.4)
      milkyCol[i * 3 + 1] = (0.7 + warmth * 0.2) * (0.6 + centerFade * 0.4)
      milkyCol[i * 3 + 2] = (0.8 + Math.random() * 0.2) * (0.6 + centerFade * 0.4)
    }
    const milkyGeo = new BufferGeometry()
    milkyGeo.setAttribute('position', new Float32BufferAttribute(milkyPos, 3))
    milkyGeo.setAttribute('color', new Float32BufferAttribute(milkyCol, 3))
    const milkyWay = new Points(milkyGeo, new PointsMaterial({
      size: 1.8, vertexColors: true, transparent: true, opacity: 0.35,
      sizeAttenuation: false, depthTest: false, depthWrite: false,
    }))
    milkyWay.renderOrder = -1
    group.add(milkyWay)

    // Milky Way core glow — concentrated bright band at center
    const coreTex = makeNebulaTexture(200, 190, 170)
    const coreMat = new SpriteMaterial({
      map: coreTex, transparent: true, opacity: 0.06,
      blending: AdditiveBlending, depthWrite: false,
    })
    const coreSprite = new Sprite(coreMat)
    coreSprite.position.set(0, 0, -6000)
    coreSprite.scale.set(8000, 800, 1)
    group.add(coreSprite)
  }

  // ── Asteroid field — rocky particles in orbital bands ──
  if (options.asteroids) {
    const asteroidCount = 500
    const asteroidPos = new Float32Array(asteroidCount * 3)
    const asteroidCol = new Float32Array(asteroidCount * 3)
    for (let i = 0; i < asteroidCount; i++) {
      const r = 1500 + Math.random() * 3500
      const theta = Math.random() * Math.PI * 2
      // Flattened orbital plane with some scatter
      const ySpread = (Math.random() - 0.5) * 400
      asteroidPos[i * 3]     = r * Math.cos(theta) + (Math.random() - 0.5) * 150
      asteroidPos[i * 3 + 1] = ySpread
      asteroidPos[i * 3 + 2] = r * Math.sin(theta) + (Math.random() - 0.5) * 150
      // Rocky browns and greys
      const shade = 0.2 + Math.random() * 0.25
      asteroidCol[i * 3]     = shade * (1.0 + Math.random() * 0.3)
      asteroidCol[i * 3 + 1] = shade * (0.85 + Math.random() * 0.15)
      asteroidCol[i * 3 + 2] = shade * (0.7 + Math.random() * 0.15)
    }
    const asteroidGeo = new BufferGeometry()
    asteroidGeo.setAttribute('position', new Float32BufferAttribute(asteroidPos, 3))
    asteroidGeo.setAttribute('color', new Float32BufferAttribute(asteroidCol, 3))
    const asteroids = new Points(asteroidGeo, new PointsMaterial({
      size: 3, vertexColors: true, transparent: true, opacity: 0.5,
      sizeAttenuation: true, depthWrite: false,
    }))
    group.add(asteroids)
  }

  // ── Inner stars — mid-field particles surrounding the graph ──
  if (options.innerStars) {
    // Dim layer: 2000 particles, radius 600-1500, three color variants
    const dimCount = 2000
    const dimPos = new Float32Array(dimCount * 3)
    const dimCol = new Float32Array(dimCount * 3)

    for (let i = 0; i < dimCount; i++) {
      const r = 600 + Math.random() * 900
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      dimPos[i * 3]     = r * Math.sin(phi) * Math.cos(theta)
      dimPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      dimPos[i * 3 + 2] = r * Math.cos(phi)

      const t = Math.random()
      if (t < 0.6) {
        // Cool white/blue
        dimCol[i * 3] = 0.8 + Math.random() * 0.2
        dimCol[i * 3 + 1] = 0.85 + Math.random() * 0.15
        dimCol[i * 3 + 2] = 1.0
      } else if (t < 0.8) {
        // Warm yellow
        dimCol[i * 3] = 1.0
        dimCol[i * 3 + 1] = 0.9 + Math.random() * 0.1
        dimCol[i * 3 + 2] = 0.5 + Math.random() * 0.3
      } else {
        // Blue
        dimCol[i * 3] = 0.4 + Math.random() * 0.2
        dimCol[i * 3 + 1] = 0.5 + Math.random() * 0.2
        dimCol[i * 3 + 2] = 1.0
      }
    }

    const dimGeo = new BufferGeometry()
    dimGeo.setAttribute('position', new Float32BufferAttribute(dimPos, 3))
    dimGeo.setAttribute('color', new Float32BufferAttribute(dimCol, 3))
    group.add(new Points(dimGeo, new PointsMaterial({
      size: 0.8, vertexColors: true, transparent: true, opacity: 0.6,
      sizeAttenuation: true, depthWrite: false,
    })))

    // Bright layer: 300 particles, radius 500-1500, white-blue
    const brightCount = 300
    const brightPos = new Float32Array(brightCount * 3)
    const brightCol = new Float32Array(brightCount * 3)

    for (let i = 0; i < brightCount; i++) {
      const r = 500 + Math.random() * 1000
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      brightPos[i * 3]     = r * Math.sin(phi) * Math.cos(theta)
      brightPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      brightPos[i * 3 + 2] = r * Math.cos(phi)

      brightCol[i * 3] = 0.85 + Math.random() * 0.15
      brightCol[i * 3 + 1] = 0.9 + Math.random() * 0.1
      brightCol[i * 3 + 2] = 1.0
    }

    const brightGeo = new BufferGeometry()
    brightGeo.setAttribute('position', new Float32BufferAttribute(brightPos, 3))
    brightGeo.setAttribute('color', new Float32BufferAttribute(brightCol, 3))
    group.add(new Points(brightGeo, new PointsMaterial({
      size: 2.0, vertexColors: true, transparent: true, opacity: 0.9,
      sizeAttenuation: true, depthWrite: false,
    })))
  }

  return group
}

function disposeStarfield(group: Group) {
  group.traverse((obj) => {
    if (obj instanceof Points || obj instanceof Mesh) {
      obj.geometry?.dispose()
      const mat = obj.material
      if (Array.isArray(mat)) mat.forEach(m => m.dispose())
      else mat?.dispose()
    }
    if (obj instanceof Sprite) {
      obj.material?.map?.dispose()
      obj.material?.dispose()
    }
  })
}

// ── Progressive label visibility threshold ───────────────────────────────────
// Camera must be within this distance for node labels to appear.
// Mimics Obsidian's "zoom in to read" behavior.
const LABEL_SHOW_DISTANCE = 500  // Topic labels visible from farther away
const LABEL_MIN_IMPORTANCE = 0.3 // (no longer used — cluster rep logic in Brain.tsx)

// ── Layout cache — survives unmount, enables instant re-mount ────────────────
// When the simulation settles, we snapshot every node's (x,y,z) into this
// module-level Map. On re-mount with the same nodes, we inject these as
// starting positions and skip the warmup entirely.
// Camera state is saved on unmount so zoom/pan is preserved too.
const _positionCache = new Map<string, { x: number; y: number; z: number }>()
let _cameraCache: {
  position: { x: number; y: number; z: number }
  target: { x: number; y: number; z: number }
  sceneRotY: number
} | null = null

function savePositionCache(graphData: { nodes: any[] }) {
  _positionCache.clear()
  for (const n of graphData.nodes) {
    if (n.id && n.x != null) {
      _positionCache.set(n.id, { x: n.x, y: n.y ?? 0, z: n.z ?? 0 })
    }
  }
}

function applyPositionCache(graphNodes: any[]): boolean {
  if (_positionCache.size === 0) return false
  let hits = 0
  for (const n of graphNodes) {
    const cached = _positionCache.get(n.id)
    if (cached) {
      n.x = cached.x; n.y = cached.y; n.z = cached.z
      hits++
    }
  }
  // Only use cache if most nodes have cached positions
  return hits > graphNodes.length * 0.8
}

// ── Component ────────────────────────────────────────────────────────────────

export const ForceGraph3D = forwardRef<ForceGraph3DHandle, ForceGraph3DProps>(function ForceGraph3D({
  nodes,
  edges,
  clusters,
  selectedId,
  onSelectNode,
  onBackgroundClick,
  autoSpin = true,
  paused = false,
  bgColor = '#000000',
  className,
  focusClusterId,
  focusClusterTs,
  focusNodeId,
  focusNodeTs,
  layoutPreset = DEFAULT_LAYOUT,
  neuralMode,
  showBackgroundStars = true,
  showInnerStars = false,
  showNebulae = true,
  showEdges = true,
  showCelestialObjects = true,
  showClusterGalaxies = true,
  showMilkyWay = true,
  showAsteroids = true,
  showSolarSystems = true,
  clusterSeparation = 0.3,
  colorBy = 'type',
  onReady,
}: ForceGraph3DProps, ref) {
  const useClusterColors = (clusters?.length ?? 0) > 0
  const isLargeGraph = nodes.length > 200
  const layoutRef = useRef(LAYOUT_PRESETS[layoutPreset] ?? LAYOUT_PRESETS[DEFAULT_LAYOUT])
  const containerRef = useRef<HTMLDivElement>(null)
  const coreGeoRef = useRef(new SphereGeometry(1, 10, 10))
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const hitGeoRef = useRef(new BoxGeometry(1, 1, 1))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null)
  const initializedRef = useRef(false)
  const spinningRef = useRef(true)
  const starfieldRef = useRef<Group | null>(null)
  const bgColorRef = useRef(bgColor)
  bgColorRef.current = bgColor
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bloomPassRef = useRef<any>(null)
  const neuralModeRef = useRef(neuralMode)
  neuralModeRef.current = neuralMode
  const showBgStarsRef = useRef(showBackgroundStars)
  showBgStarsRef.current = showBackgroundStars
  const showInnerStarsRef = useRef(showInnerStars)
  showInnerStarsRef.current = showInnerStars
  const showNebulaeRef = useRef(showNebulae)
  showNebulaeRef.current = showNebulae
  const showCelestialRef = useRef(showCelestialObjects)
  showCelestialRef.current = showCelestialObjects
  const showClusterGalaxiesRef = useRef(showClusterGalaxies)
  showClusterGalaxiesRef.current = showClusterGalaxies
  const showMilkyWayRef = useRef(showMilkyWay)
  showMilkyWayRef.current = showMilkyWay
  const showAsteroidsRef = useRef(showAsteroids)
  showAsteroidsRef.current = showAsteroids
  const showSolarSystemsRef = useRef(showSolarSystems)
  showSolarSystemsRef.current = showSolarSystems
  const clusterSeparationRef = useRef(clusterSeparation)
  clusterSeparationRef.current = clusterSeparation
  const showEdgesRef = useRef(showEdges)
  useEffect(() => { showEdgesRef.current = showEdges }, [showEdges])
  const colorByRef = useRef(colorBy)
  colorByRef.current = colorBy
  // Instanced star rendering — single draw call for all nodes
  const instancedMeshRef = useRef<InstancedMesh | null>(null)
  const nodeIndexMapRef = useRef<Map<string, number>>(new Map())
  // Skip per-frame position sync once the force simulation has cooled down
  const simulationStableRef = useRef(false)
  // Hide links during simulation warmup — they're invisible during fast movement anyway
  const linksVisibleRef = useRef(false)
  // Activity visualization refs (imperative handle)
  const globalPulseRef = useRef<{ active: boolean; startTime: number; duration: number }>({ active: false, startTime: 0, duration: 0 })
  // Keep-alive pause/resume
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const rotationFrameRef = useRef(0)
  const tickFnRef = useRef<(() => void) | null>(null)

  useImperativeHandle(ref, () => ({
    highlightNodes(ids: string[]) {
      const mesh = instancedMeshRef.current
      if (!mesh) return
      const now = sharedUniforms.uTime.value
      const geo = mesh.geometry
      const attr = geo.getAttribute('aHighlightStart') as InstancedBufferAttribute
      if (!attr) return
      for (const id of ids) {
        const i = nodeIndexMapRef.current.get(id)
        if (i !== undefined) attr.setX(i, now)
      }
      attr.needsUpdate = true

      // Dim non-highlighted nodes during activation cascade
      sharedUniforms.uDimOthers.value = 1.0
      const dimStart = performance.now()
      const dimDuration = 5000 // match highlight duration
      const fadeDim = () => {
        const elapsed = performance.now() - dimStart
        if (elapsed >= dimDuration) {
          sharedUniforms.uDimOthers.value = 0.0
          return
        }
        // Hold at full dim for 3s, then fade out over remaining 2s
        if (elapsed < 3000) {
          sharedUniforms.uDimOthers.value = 1.0
        } else {
          sharedUniforms.uDimOthers.value = 1.0 - (elapsed - 3000) / 2000
        }
        requestAnimationFrame(fadeDim)
      }
      requestAnimationFrame(fadeDim)
    },
    pulseAll(durationMs: number) {
      globalPulseRef.current = { active: true, startTime: Date.now(), duration: durationMs }
    },
    fadeInNodes(ids: string[]) {
      const mesh = instancedMeshRef.current
      if (!mesh) return
      const now = sharedUniforms.uTime.value
      const geo = mesh.geometry
      const attr = geo.getAttribute('aBirthTime') as InstancedBufferAttribute
      if (!attr) return
      for (const id of ids) {
        const i = nodeIndexMapRef.current.get(id)
        if (i !== undefined) attr.setX(i, now)
      }
      attr.needsUpdate = true
    },
  }))

  const onSelectNodeRef = useRef(onSelectNode)
  onSelectNodeRef.current = onSelectNode
  const onBackgroundClickRef = useRef(onBackgroundClick)
  onBackgroundClickRef.current = onBackgroundClick

  // Single effect: init graph + load data together
  useEffect(() => {
    const el = containerRef.current
    if (!el || !nodes.length) return

    // If already initialized, just update data and rebuild instanced stars
    if (graphRef.current && initializedRef.current) {
      const graph = graphRef.current
      simulationStableRef.current = false
      updateGraphData(graph, nodes, edges, useClusterColors, layoutRef.current, { showGalaxies: showClusterGalaxiesRef.current })

      // Dispose old instanced mesh and rebuild with new nodes
      if (instancedMeshRef.current) {
        graph.scene().remove(instancedMeshRef.current)
        instancedMeshRef.current.geometry.dispose()
        ;(instancedMeshRef.current.material as ShaderMaterial).dispose()
        instancedMeshRef.current = null
      }
      if (nodes.length > 0) {
        const { mesh: newMesh, nodeIndexMap } = buildStarInstances(
          nodes,
          coreGeoRef.current,
          clusters,
          neuralModeRef.current?.enabled ?? false,
          colorByRef.current,
        )
        instancedMeshRef.current = newMesh
        nodeIndexMapRef.current = nodeIndexMap
        graph.scene().add(newMesh)
      }
      return
    }

    // Wait for container to have dimensions
    const width = el.clientWidth
    const height = el.clientHeight
    if (width === 0 || height === 0) return

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const graph = (ForceGraph3DLib as any)()(el)
      .width(width)
      .height(height)
      .backgroundColor(bgColorRef.current === 'galaxy' ? '#000000' : bgColorRef.current)
      .showNavInfo(false)

      // ── Node appearance ──────────────────────────────────────────────
      .nodeVal((node: any) => 1 + (node.importance ?? 0) * 8)
      .nodeLabel((node: any) => {
        const type = node.type === 'self_model' ? 'self model' : (node.type ?? '')
        const color = getNodeColor(node, useClusterColors, neuralModeRef.current?.enabled, colorByRef.current)
        const clusterLine = node.cluster_label
          ? `<div style="color:${color};font-weight:600;margin-bottom:2px;font-size:10px;letter-spacing:0.5px;">${node.cluster_label}</div>`
          : ''
        return `<div style="background:rgba(9,9,11,0.92);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:8px 12px;max-width:300px;font-family:system-ui;font-size:12px;pointer-events:none;">
          ${clusterLine}
          <div style="color:#71717a;text-transform:uppercase;font-size:9px;letter-spacing:0.5px;margin-bottom:3px;">${type}</div>
          <div style="color:#e4e4e7;line-height:1.4;">${node.content ?? node.type}</div>
          ${node.access_count != null ? `<div style="color:#71717a;font-size:10px;margin-top:4px;">${node.access_count.toLocaleString()} recalls</div>` : ''}
        </div>`
      })
      .nodeThreeObject((node: any) => {
        const importance = node.importance ?? 0
        const radius = 2 + importance * 6

        // Invisible hit sphere for click/hover detection —
        // visual rendering is handled by the single InstancedMesh
        const hitMat = new MeshBasicMaterial({ visible: false })
        const hitMesh = new Mesh(hitGeoRef.current, hitMat)
        hitMesh.scale.setScalar(radius * 1.5) // slightly larger for comfortable clicking

        // Show topic labels: one per cluster, on the most important node in that cluster.
        // Works on all graph sizes — max ~20 labels keeps it clean.
        if (node._isClusterRep && node.cluster_label) {
          const color = getNodeColor(node, useClusterColors, neuralModeRef.current?.enabled, colorByRef.current)
          const group = new Group()
          group.add(hitMesh)
          const labelTex = makeNodeLabelTexture(node.cluster_label, color)
          const labelMat = new SpriteMaterial({
            map: labelTex,
            transparent: true,
            depthWrite: false,
            depthTest: false,
          })
          const labelSprite = new Sprite(labelMat)
          labelSprite.scale.set(28, 3.5, 1)
          labelSprite.position.set(0, -(radius + 5), 0)
          labelSprite.visible = false
          labelSprite.name = 'nodeLabel'
          group.add(labelSprite)
          return group
        }

        return hitMesh
      })
      .nodeThreeObjectExtend(false)

      // ── Position sync — merge hit mesh + InstancedMesh updates into one pass ──
      .nodePositionUpdate((obj: any, coords: any, node: any) => {
        obj.position.set(coords.x, coords.y || 0, coords.z || 0)
        if (!simulationStableRef.current && instancedMeshRef.current) {
          const idx = nodeIndexMapRef.current.get(node.id)
          if (idx !== undefined) {
            _syncDummy.position.set(coords.x, coords.y || 0, coords.z || 0)
            _syncDummy.scale.setScalar(2 + (node.importance ?? 0) * 6)
            _syncDummy.updateMatrix()
            instancedMeshRef.current.setMatrixAt(idx, _syncDummy.matrix)
            instancedMeshRef.current.instanceMatrix.needsUpdate = true
          }
        }
        return true // tell library we handled it
      })

      // ── Link appearance ──────────────────────────────────────────────
      .linkVisibility(() => linksVisibleRef.current && showEdgesRef.current)
      .linkColor((link: any) => {
        const sourceNode = typeof link.source === 'object' ? link.source : null
        if (!sourceNode) return '#60a5fa'
        return getNodeColor(sourceNode, useClusterColors, neuralModeRef.current?.enabled, colorByRef.current)
      })
      .linkOpacity(isLargeGraph ? 0.15 : 0.4)
      .linkWidth((link: any) => isLargeGraph ? 0.3 + (link.weight ?? 0) * 0.8 : 0.6 + (link.weight ?? 0) * 1.8)
      .linkDirectionalParticles((link: any) => {
        if (!showEdgesRef.current) return 0
        if (neuralModeRef.current?.particlesAlways) {
          return Math.max(1, Math.ceil((link.weight ?? 0.5) * 2))
        }
        return isLargeGraph ? 0 : Math.ceil((link.weight ?? 0.5) * 3)
      })
      .linkDirectionalParticleWidth(1.2)
      .linkDirectionalParticleSpeed(0.005)
      .linkDirectionalParticleColor(() => getAccentColor())

      // ── Interaction ──────────────────────────────────────────────────
      .onNodeClick((node: any) => {
        onSelectNodeRef.current(node.id)
        // Stop auto-spin — scene rotation fights camera animation
        spinningRef.current = false
        // Freeze node so it doesn't drift during camera fly-in
        node.fx = node.x
        node.fy = node.y
        node.fz = node.z
        // Compensate for accumulated scene rotation
        const scene = graph.scene()
        const pos = new Vector3(node.x, node.y, node.z)
        pos.applyEuler(scene.rotation)
        const distance = 80
        graph.cameraPosition(
          { x: pos.x, y: pos.y, z: pos.z + distance },
          { x: pos.x, y: pos.y, z: pos.z },
          800,
        )
        // Unfreeze after camera arrives
        setTimeout(() => {
          node.fx = undefined
          node.fy = undefined
          node.fz = undefined
        }, 900)
      })
      .onBackgroundClick(() => {
        onBackgroundClickRef.current?.()
      })
      .enableNodeDrag(false)

      // ── Forces ───────────────────────────────────────────────────────
      // Organic force-directed layout — let topology create clusters
      // naturally. No artificial sphere positioning.
      .d3AlphaDecay(0.04)
      .d3VelocityDecay(0.4)
      .warmupTicks(0)
      .cooldownTicks(500)

    try {
      if (isLargeGraph) {
        const cfg = layoutRef.current
        graph.d3Force('charge')?.strength(cfg.charge).distanceMax(250)
        // Link force disabled — user feedback: orbs visibly clump together as
        // related ones get pulled in. Charge alone gives a spread-out layout
        // without sacrificing the meaningful position of focus-zoomed selections.
        graph.d3Force('link')?.strength(0)
        graph.d3Force('center')?.strength(0.008)
      } else {
        // Link force disabled — see large-graph branch.
        graph.d3Force('link')?.strength(0)
        graph.d3Force('charge')?.strength(-80)
      }
    } catch { /* force config may fail silently */ }

    // ── Topic clustering force with configurable separation ──────────────
    // Nudge nodes toward their topic cluster target. The target blends
    // between the emergent centroid (organic) and a Fibonacci sphere home
    // position (structured), controlled by clusterSeparation (0-1).
    graph.onEngineTick(() => {
      const data = graph.graphData()
      if (!data?.nodes?.length) return

      const sep = clusterSeparationRef.current
      const homeWeight = sep * 0.6
      const strength = 0.003 + sep * 0.005

      // Compute centroid per cluster (skip uncategorized)
      const centroids = new Map<number, { x: number; y: number; z: number; count: number }>()
      for (const node of data.nodes) {
        if (node.x == null || node.cluster_id == null) continue
        if (node.cluster_label === 'Uncategorized') continue
        const c = centroids.get(node.cluster_id) ?? { x: 0, y: 0, z: 0, count: 0 }
        c.x += node.x; c.y += node.y; c.z += node.z; c.count++
        centroids.set(node.cluster_id, c)
      }

      // Assign Fibonacci homes for clusters we haven't seen yet
      const totalClusters = centroids.size
      let idx = 0
      for (const cid of centroids.keys()) {
        const key = String(cid)
        if (!clusterHomePositions.has(key)) {
          clusterHomePositions.set(key, fibonacciSphere(idx, totalClusters, 150))
        }
        idx++
      }

      for (const node of data.nodes) {
        if (node.x == null || node.cluster_id == null) continue
        if (node.cluster_label === 'Uncategorized') continue
        const c = centroids.get(node.cluster_id)
        if (!c || c.count < 2) continue

        const centX = c.x / c.count, centY = c.y / c.count, centZ = c.z / c.count
        const home = clusterHomePositions.get(String(node.cluster_id))

        // Blend centroid with Fibonacci home based on separation
        let tx = centX, ty = centY, tz = centZ
        if (home && homeWeight > 0) {
          tx = centX * (1 - homeWeight) + home.x * homeWeight
          ty = centY * (1 - homeWeight) + home.y * homeWeight
          tz = centZ * (1 - homeWeight) + home.z * homeWeight
        }

        const dx = tx - node.x, dy = ty - node.y, dz = tz - node.z
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (dist < 15) continue
        node.vx = (node.vx ?? 0) + dx * strength
        node.vy = (node.vy ?? 0) + dy * strength
        node.vz = (node.vz ?? 0) + dz * strength
      }
    })

    // Disable pointer interaction during layout settling — raycasting all scene objects
    // every 50ms is wasted work while the graph is still moving
    graph.enablePointerInteraction(false)

    // ── Simulation stabilization — stop syncing positions once layout cools ──
    graph.onEngineStop(() => {
      simulationStableRef.current = true
      // Final sync to ensure InstancedMesh reflects settled positions
      if (instancedMeshRef.current && nodeIndexMapRef.current.size > 0) {
        const data = graph.graphData()
        syncInstancePositions(instancedMeshRef.current, data.nodes, nodeIndexMapRef.current)
      }
      // Cache settled positions for instant re-mount
      savePositionCache(graph.graphData())
      // Re-enable interaction and links now that the graph is stable
      graph.enablePointerInteraction(true)
      linksVisibleRef.current = true
      // Re-fit camera now that the layout is settled — initial fit happened
      // when the bounding box was barely-formed (mostly at origin), leaving
      // user zoomed in.  Skip if the user already moved the camera (camera cache
      // is populated only by user pan/zoom interaction or by re-mount).
      if (!_cameraCache) {
        try { graph.zoomToFit(800, 80) } catch { /* ok */ }
      }
    })

    // ── Bloom post-processing ──────────────────────────────────────────
    try {
      const bloomStrength = neuralModeRef.current?.enabled
        ? (neuralModeRef.current.bloomStrength ?? 0.2)
        : 0.2
      const bloomPass = new UnrealBloomPass(
        new Vector2(Math.floor(width / 2), Math.floor(height / 2)),
        bloomStrength,   // strength
        0.6,   // radius — wider halo for star glow
        0.15,  // threshold — catch dimmer star cores
      )
      bloomPassRef.current = bloomPass
      graph.postProcessingComposer().addPass(bloomPass)
    } catch (e) {
      console.warn('Bloom pass failed, continuing without glow:', e)
    }

    // ── Auto-rotation — spins until user interacts, resets on remount ────
    spinningRef.current = autoSpin

    const camPos = new Vector3()
    const nodePos = new Vector3()

    let tickCount = 0
    const tick = () => {
      if (pausedRef.current) return  // Keep-alive: skip work when hidden
      sharedUniforms.uTime.value = Date.now() * 0.001
      tickCount++

      // Slow auto-rotate
      if (spinningRef.current) {
        try { graph.scene().rotation.y += 0.001 } catch { /* ok */ }
      }

      // Parallax — shift background opposite to camera for depth
      if (starfieldRef.current) {
        try {
          const cam = graph.camera().position
          starfieldRef.current.position.set(-cam.x * 0.02, -cam.y * 0.02, -cam.z * 0.02)
        } catch { /* ok during init */ }
      }

      // Animate orbiting planets in solar systems
      if (orbitingPlanets.length > 0) {
        const t = Date.now() * 0.001
        for (const p of orbitingPlanets) {
          const angle = p.phase + t * p.speed
          p.sprite.position.set(
            p.cx + Math.cos(angle) * p.radius,
            p.cy + Math.sin(angle) * p.radius * Math.sin(p.tilt),
            p.cz + Math.sin(angle) * p.radius * Math.cos(p.tilt),
          )
        }
      }

      // Progressive label visibility — throttle to every 5th frame
      if (tickCount % 5 === 0) {
        try {
          const camera = graph.camera()
          camPos.copy(camera.position)

          const data = graph.graphData()
          for (const node of data.nodes) {
            const obj = node.__threeObj
            if (!obj) continue
            const label = obj.getObjectByName('nodeLabel')
            if (!label) continue

            nodePos.set(node.x ?? 0, node.y ?? 0, node.z ?? 0)
            nodePos.applyMatrix4(graph.scene().matrixWorld)
            const dist = camPos.distanceTo(nodePos)

            if (dist < LABEL_SHOW_DISTANCE) {
              label.visible = true
              const t = 1 - (dist / LABEL_SHOW_DISTANCE)
              label.material.opacity = t * t
            } else {
              label.visible = false
            }
          }
        } catch { /* ok during init */ }
      }

      // ── Neural mode pulsation + bloom breathing ─────────────────────
      try {
        const neuralCfg = neuralModeRef.current
        if (neuralCfg?.enabled) {
          const time = Date.now() * 0.001

          // Global bloom breathing
          if (bloomPassRef.current) {
            const baseStrength = neuralCfg.bloomStrength ?? 0.2
            const breathe = 1 + Math.sin(time * 0.02 * Math.PI * 2) * 0.05
            bloomPassRef.current.strength = baseStrength * breathe
          }
        }
      } catch { /* ok during init */ }

      // ── Activity visualization: global pulse ────────────────────────
      try {
        if (globalPulseRef.current.active && bloomPassRef.current) {
          const elapsed = Date.now() - globalPulseRef.current.startTime
          if (elapsed > globalPulseRef.current.duration) {
            globalPulseRef.current.active = false
          } else {
            const t = elapsed / globalPulseRef.current.duration
            bloomPassRef.current.strength += Math.sin(t * Math.PI) * 0.3
          }
        }
      } catch { /* ok */ }

      rotationFrameRef.current = requestAnimationFrame(tick)
    }
    tickFnRef.current = tick
    tick()

    // Stop spinning on any user interaction with the graph
    const stopSpin = () => { spinningRef.current = false }
    el.addEventListener('pointerdown', stopSpin)

    graphRef.current = graph
    initializedRef.current = true

    // Signal ready after the first frame renders (not synchronously —
    // warmup blocks the main thread, so the loading overlay needs to
    // stay visible until the browser has actually painted the graph)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      onReadyRef.current?.()
    }))

    // If mounted in paused state (keep-alive background init), pause after warmup completes
    if (pausedRef.current) {
      try { graph.pauseAnimation() } catch { /* ok */ }
    }

    // Push camera far plane to see distant stars, milky way, and solar systems
    const camera = graph.camera()
    if (camera) { camera.far = 50000; camera.updateProjectionMatrix() }

    // Attach starfield if galaxy mode at init
    if (bgColorRef.current === 'galaxy') {
      const sf = createStarfield({ bgStars: showBgStarsRef.current, innerStars: showInnerStarsRef.current, nebulae: showNebulaeRef.current, celestialObjects: showCelestialRef.current, milkyWay: showMilkyWayRef.current, asteroids: showAsteroidsRef.current, solarSystems: showSolarSystemsRef.current })
      graph.scene().add(sf)
      starfieldRef.current = sf
    }

    // Load initial data
    updateGraphData(graph, nodes, edges, useClusterColors, layoutRef.current, { showGalaxies: showClusterGalaxiesRef.current })

    // Build instanced star rendering after data is loaded
    const graphData = graph.graphData()
    if (graphData.nodes.length > 0) {
      const { mesh: starMesh, nodeIndexMap } = buildStarInstances(
        graphData.nodes,
        coreGeoRef.current,
        clusters,
        neuralModeRef.current?.enabled ?? false,
        colorByRef.current,
      )
      instancedMeshRef.current = starMesh
      nodeIndexMapRef.current = nodeIndexMap
      graph.scene().add(starMesh)
    }

    // Handle resize
    const ro = new ResizeObserver(([entry]) => {
      const { width: w, height: h } = entry.contentRect
      if (w > 0 && h > 0) graph.width(w).height(h)
    })
    ro.observe(el)

    return () => {
      // Save camera state for re-mount
      try {
        const cam = graph.camera()
        const ctrl = graph.controls()
        _cameraCache = {
          position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
          target: ctrl.target ? { x: ctrl.target.x, y: ctrl.target.y, z: ctrl.target.z } : { x: 0, y: 0, z: 0 },
          sceneRotY: graph.scene().rotation.y,
        }
      } catch { /* ok */ }

      cancelAnimationFrame(rotationFrameRef.current)
      tickFnRef.current = null
      el.removeEventListener('pointerdown', stopSpin)
      ro.disconnect()
      if (starfieldRef.current) {
        disposeStarfield(starfieldRef.current)
        starfieldRef.current = null
      }
      // Dispose instanced star mesh
      if (instancedMeshRef.current) {
        instancedMeshRef.current.geometry.dispose()
        ;(instancedMeshRef.current.material as ShaderMaterial).dispose()
        instancedMeshRef.current = null
        nodeIndexMapRef.current = new Map()
      }
      initializedRef.current = false
      graphRef.current = null
      try { graph._destructor?.() } catch { /* ok */ }
      while (el.firstChild) el.removeChild(el.firstChild)
    }
  }, [nodes, edges, colorBy])

  // Sync autoSpin prop to ref
  useEffect(() => {
    spinningRef.current = autoSpin
  }, [autoSpin])

  // Keep-alive: pause/resume rendering when visibility changes
  useEffect(() => {
    const graph = graphRef.current
    if (!graph || !initializedRef.current) return

    if (paused) {
      cancelAnimationFrame(rotationFrameRef.current)
      try { graph.pauseAnimation() } catch { /* ok */ }
    } else {
      try { graph.resumeAnimation() } catch { /* ok */ }
      // Restart our custom tick loop
      if (tickFnRef.current) tickFnRef.current()
    }
  }, [paused])

  // Live-update background + starfield without reinitializing graph
  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return

    const scene = graph.scene()

    // Remove existing starfield
    if (starfieldRef.current) {
      scene.remove(starfieldRef.current)
      disposeStarfield(starfieldRef.current)
      starfieldRef.current = null
    }

    if (bgColor === 'galaxy') {
      graph.backgroundColor('#000000')
      const sf = createStarfield({ bgStars: showBackgroundStars, innerStars: showInnerStars, nebulae: showNebulae, celestialObjects: showCelestialObjects, milkyWay: showMilkyWay, asteroids: showAsteroids, solarSystems: showSolarSystems })
      scene.add(sf)
      starfieldRef.current = sf
    } else {
      graph.backgroundColor(bgColor)
    }
  }, [bgColor, showBackgroundStars, showInnerStars, showNebulae, showCelestialObjects, showMilkyWay, showAsteroids, showSolarSystems])

  // Live-update edge visibility when toggled
  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    showEdgesRef.current = showEdges
    graph.linkVisibility(() => linksVisibleRef.current && showEdgesRef.current)
    graph.linkDirectionalParticles((link: any) => {
      if (!showEdgesRef.current) return 0
      if (neuralModeRef.current?.particlesAlways) {
        return Math.max(1, Math.ceil((link.weight ?? 0.5) * 2))
      }
      return 0
    })
  }, [showEdges])

  // Live-update galaxy halos visibility
  useEffect(() => {
    for (const visual of clusterVisuals) {
      visual.visible = showClusterGalaxies
    }
  }, [showClusterGalaxies])

  // Layout preset is now fixed (single "clustered" layout) — no dynamic switching needed

  // Highlight selected node via instanced attribute (nodeColor is dead code with nodeThreeObjectExtend(false))
  useEffect(() => {
    const mesh = instancedMeshRef.current
    if (!mesh) return
    const attr = mesh.geometry.getAttribute('aHighlightStart') as InstancedBufferAttribute | null
    if (!attr) return
    const now = sharedUniforms.uTime.value

    if (selectedId) {
      const i = nodeIndexMapRef.current.get(selectedId)
      if (i !== undefined) {
        attr.setX(i, now)
        attr.needsUpdate = true
      }
    }
  }, [selectedId])

  // Navigate camera to a cluster's centroid
  useEffect(() => {
    const graph = graphRef.current
    if (!graph || focusClusterId == null) return
    const data = graph.graphData()
    const clusterNodes = data.nodes.filter((n: any) => n.cluster_id === focusClusterId)
    if (!clusterNodes.length) return

    const cx = clusterNodes.reduce((s: number, n: any) => s + (n.x ?? 0), 0) / clusterNodes.length
    const cy = clusterNodes.reduce((s: number, n: any) => s + (n.y ?? 0), 0) / clusterNodes.length
    const cz = clusterNodes.reduce((s: number, n: any) => s + (n.z ?? 0), 0) / clusterNodes.length

    const maxDist = Math.max(...clusterNodes.map((n: any) =>
      Math.sqrt(((n.x ?? 0) - cx) ** 2 + ((n.y ?? 0) - cy) ** 2 + ((n.z ?? 0) - cz) ** 2)
    ))
    const distance = Math.max(maxDist * 2.5, 60)

    spinningRef.current = false
    // Compensate for accumulated scene rotation
    const pos = new Vector3(cx, cy, cz)
    pos.applyEuler(graph.scene().rotation)
    graph.cameraPosition(
      { x: pos.x, y: pos.y, z: pos.z + distance },
      { x: pos.x, y: pos.y, z: pos.z },
      1000,
    )

    // Cluster focus animation — boost focused halo, dim others
    const halos = clusterVisuals.filter(
      (s): s is Sprite => s.userData?.type === 'clusterHalo'
    )
    for (const h of halos) {
      const mat = h.material as SpriteMaterial
      mat.opacity = h.userData.clusterId === focusClusterId ? 0.15 : 0.02
    }
    const restoreTimer = setTimeout(() => {
      for (const h of halos) {
        const mat = h.material as SpriteMaterial
        mat.opacity = h.userData.baseOpacity
      }
    }, 2000)
    return () => clearTimeout(restoreTimer)
  }, [focusClusterId, focusClusterTs])

  // Navigate camera to a specific node
  useEffect(() => {
    const graph = graphRef.current
    if (!graph || !focusNodeId) return
    const data = graph.graphData()
    const node = data.nodes.find((n: any) => n.id === focusNodeId)
    if (!node || node.x == null) return

    spinningRef.current = false
    // Compensate for accumulated scene rotation
    const pos = new Vector3(node.x, node.y, node.z)
    pos.applyEuler(graph.scene().rotation)
    graph.cameraPosition(
      { x: pos.x, y: pos.y, z: pos.z + 60 },
      { x: pos.x, y: pos.y, z: pos.z },
      800,
    )
  }, [focusNodeId, focusNodeTs])

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: '100%', height: '100%' }}
    />
  )
})

// ── Helpers ──────────────────────────────────────────────────────────────────

const CLUSTER_MIN_NODES = 2
const TYPE_LABELS: Record<string, string> = {
  fact: 'FACTS',
  entity: 'ENTITIES',
  preference: 'PREFERENCES',
  procedure: 'PROCEDURES',
  self_model: 'SELF MODEL',
  episode: 'EPISODES',
  schema: 'SCHEMAS',
  goal: 'GOALS',
}

// Track cluster visuals so we can remove them on update
const clusterVisuals: (Sprite | Mesh | Points)[] = []

function updateGraphData(graph: any, nodes: GraphNode[], edges: GraphEdge[], useClusterMode: boolean, config?: LayoutConfig, galaxyOptions?: { showGalaxies: boolean }) {
  const cfg = config ?? LAYOUT_PRESETS[DEFAULT_LAYOUT]
  const graphNodes = nodes.map(n => ({ ...n })) as any[]
  const nodeIds = new Set(nodes.map(n => n.id))
  const graphLinks = edges
    .filter(e => nodeIds.has(e.source) && nodeIds.has(e.target))
    .map(e => ({
      source: e.source,
      target: e.target,
      relation: e.relation,
      weight: e.weight,
    }))

  // Inject cached positions for instant layout (skips simulation)
  const hasCachedLayout = applyPositionCache(graphNodes)
  if (hasCachedLayout) {
    graph.warmupTicks(0).cooldownTicks(0)
  }

  graph.graphData({ nodes: graphNodes, links: graphLinks })

  // Cached layout: zoom immediately. Fresh layout: wait for simulation to settle.
  const settleMs = hasCachedLayout ? 100 : (nodes.length > 500 ? 3000 : 1200)

  // Add cluster/domain labels after simulation settles
  setTimeout(() => {
    // Restore saved camera if available (covers keep-alive re-init and re-mount).
    // Only fall back to zoomToFit for a truly first-time load with no prior camera state.
    if (_cameraCache) {
      try {
        const cam = graph.camera()
        const ctrl = graph.controls()
        const { position: p, target: t, sceneRotY } = _cameraCache
        cam.position.set(p.x, p.y, p.z)
        if (ctrl.target) ctrl.target.set(t.x, t.y, t.z)
        ctrl.update?.()
        graph.scene().rotation.y = sceneRotY
      } catch { /* ok */ }
    } else {
      try { graph.zoomToFit(600, 60) } catch { /* ok */ }
    }

    // Remove old cluster visuals
    const scene = graph.scene()
    for (const s of clusterVisuals) scene.remove(s)
    clusterVisuals.length = 0

    const data = graph.graphData()

    if (useClusterMode) {
      // ── Cluster mode: group by cluster_id, label by domain ──
      const byCluster = new Map<number, any[]>()
      for (const node of data.nodes) {
        if (node.x == null) continue
        const cid = node.cluster_id ?? -1
        const list = byCluster.get(cid) ?? []
        list.push(node)
        byCluster.set(cid, list)
      }

      for (const [clusterId, group] of byCluster) {
        if (group.length < CLUSTER_MIN_NODES) continue

        const cx = group.reduce((s: number, n: any) => s + n.x, 0) / group.length
        const cy = group.reduce((s: number, n: any) => s + n.y, 0) / group.length
        const cz = group.reduce((s: number, n: any) => s + n.z, 0) / group.length

        const maxDist = Math.max(
          ...group.map((n: any) => Math.sqrt(
            (n.x - cx) ** 2 + (n.y - cy) ** 2 + (n.z - cz) ** 2
          ))
        )
        const haloRadius = Math.max(maxDist + 15, 25)

        const color = clusterId >= 0
          ? CLUSTER_COLORS[clusterId % CLUSTER_COLORS.length]
          : DEFAULT_COLOR

        // Galaxy visuals — halo glow and dust particles per cluster
        if (galaxyOptions?.showGalaxies && clusterId >= 0 && group[0]?.cluster_label !== 'Uncategorized') {
          const clusterCount = byCluster.size
          const haloOpacity = clusterCount > 20
            ? 0.18 / Math.sqrt(clusterCount / 10)
            : 0.18

          const tmpC = new Color(color)
          const cr = Math.floor(tmpC.r * 255), cg = Math.floor(tmpC.g * 255), cb = Math.floor(tmpC.b * 255)
          const haloTex = makeClusterHaloTexture(cr, cg, cb)
          const haloMat = new SpriteMaterial({
            map: haloTex, transparent: true, opacity: haloOpacity,
            blending: AdditiveBlending, depthWrite: false,
          })
          const haloSprite = new Sprite(haloMat)
          haloSprite.position.set(cx, cy, cz)
          const haloScale = haloRadius * 3
          haloSprite.scale.set(haloScale, haloScale, 1)
          haloSprite.userData = { type: 'clusterHalo', clusterId, baseOpacity: haloOpacity }
          scene.add(haloSprite)
          clusterVisuals.push(haloSprite)

          // Dust particles — small colored Points cloud around cluster
          const dustCount = Math.min(50, Math.max(20, group.length))
          const dustPos = new Float32Array(dustCount * 3)
          const dustCol = new Float32Array(dustCount * 3)
          const dustRadius = haloRadius * 1.5
          for (let d = 0; d < dustCount; d++) {
            const seed = clusterId * 100 + d
            const pr1 = Math.sin(seed * 127.1 + 311.7) * 0.5 + 0.5
            const pr2 = Math.sin(seed * 269.5 + 183.3) * 0.5 + 0.5
            const pr3 = Math.sin(seed * 419.2 + 371.9) * 0.5 + 0.5
            const dr = dustRadius * pr1
            const dTheta = pr2 * Math.PI * 2
            const dPhi = Math.acos(2 * pr3 - 1)
            dustPos[d * 3]     = cx + dr * Math.sin(dPhi) * Math.cos(dTheta)
            dustPos[d * 3 + 1] = cy + dr * Math.sin(dPhi) * Math.sin(dTheta)
            dustPos[d * 3 + 2] = cz + dr * Math.cos(dPhi)
            dustCol[d * 3]     = tmpC.r
            dustCol[d * 3 + 1] = tmpC.g
            dustCol[d * 3 + 2] = tmpC.b
          }
          const dustGeo = new BufferGeometry()
          dustGeo.setAttribute('position', new Float32BufferAttribute(dustPos, 3))
          dustGeo.setAttribute('color', new Float32BufferAttribute(dustCol, 3))
          const dust = new Points(dustGeo, new PointsMaterial({
            size: 1.5, vertexColors: true, transparent: true, opacity: 0.5,
            sizeAttenuation: true, depthWrite: false,
          }))
          scene.add(dust)
          clusterVisuals.push(dust)
        }
      }
    } else {
      // ── Type mode: group by engram type (original behavior) ──
      const byType = new Map<string, any[]>()
      for (const node of data.nodes) {
        if (node.x == null) continue
        const list = byType.get(node.type) ?? []
        list.push(node)
        byType.set(node.type, list)
      }

      for (const [type, group] of byType) {
        if (group.length < CLUSTER_MIN_NODES) continue

        const cx = group.reduce((s: number, n: any) => s + n.x, 0) / group.length
        const cy = group.reduce((s: number, n: any) => s + n.y, 0) / group.length
        const cz = group.reduce((s: number, n: any) => s + n.z, 0) / group.length

        const maxDist = Math.max(
          ...group.map((n: any) => Math.sqrt(
            (n.x - cx) ** 2 + (n.y - cy) ** 2 + (n.z - cz) ** 2
          ))
        )
        const haloRadius = Math.max(maxDist + 15, 25)

        const color = TYPE_COLORS[type] ?? DEFAULT_COLOR

      }
    }
  }, settleMs)
}
