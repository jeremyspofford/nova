// ui-blocks/tokens.tsx — theme tones and icon names a block may use (S54a T2).
//
// Both are closed vocabularies so a block can never carry a raw colour or an
// emoji: a tone is one of five theme names (so it follows the owner's theme
// and dark mode), and an icon is a kebab-case lucide name drawn from a map
// of individually imported icons.
import { z } from 'zod'
import clsx from 'clsx'
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  BookOpen,
  Bot,
  Box,
  Calendar,
  Check,
  CheckCircle,
  Clock,
  Cloud,
  Code,
  Cpu,
  Database,
  FileText,
  Folder,
  GitBranch,
  Globe,
  HardDrive,
  Info,
  Key,
  Layers,
  Lightbulb,
  Lock,
  MessageSquare,
  Network,
  Package,
  Rocket,
  Search,
  Server,
  Settings,
  Shield,
  Sparkles,
  Star,
  Target,
  Terminal,
  TestTube,
  User,
  Users,
  Workflow,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'

export const TONES = ['accent', 'success', 'warning', 'danger', 'neutral'] as const

/** A theme tone, never a colour value. */
export const tone = z.enum(TONES)

/** A kebab-case icon name (unknown names are allowed and draw nothing). */
// Lowercase letters and digits in hyphen-joined words: rejects emoji,
// capitals, punctuation and snake_case by shape, without needing the map.
export const iconName = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'icon must be a kebab-case lucide name')

/** The curated lucide icons a block can draw, keyed by kebab-case name. */
// Imported one by one (not lucide's full `icons` map) so the bundle carries
// only these. Adding an icon is one import and one line here; ui_blocks.json
// exports the keys so her prompt lists exactly what draws.
export const ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  'alert-triangle': AlertTriangle,
  'arrow-down': ArrowDown,
  'arrow-right': ArrowRight,
  'book-open': BookOpen,
  bot: Bot,
  box: Box,
  calendar: Calendar,
  check: Check,
  'check-circle': CheckCircle,
  clock: Clock,
  cloud: Cloud,
  code: Code,
  cpu: Cpu,
  database: Database,
  'file-text': FileText,
  folder: Folder,
  'git-branch': GitBranch,
  globe: Globe,
  'hard-drive': HardDrive,
  info: Info,
  key: Key,
  layers: Layers,
  lightbulb: Lightbulb,
  lock: Lock,
  'message-square': MessageSquare,
  network: Network,
  package: Package,
  rocket: Rocket,
  search: Search,
  server: Server,
  settings: Settings,
  shield: Shield,
  sparkles: Sparkles,
  star: Star,
  target: Target,
  terminal: Terminal,
  'test-tube': TestTube,
  user: User,
  users: Users,
  workflow: Workflow,
  wrench: Wrench,
  x: X,
  zap: Zap,
}

export function BlockIcon({ name, className }: { name: string; className?: string }) {
  // Own-property lookup so "constructor" and friends stay unknown. An unknown
  // name draws nothing rather than a broken glyph: the block still reads.
  const Icon = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : undefined
  if (!Icon) return null
  return <Icon aria-hidden="true" className={clsx('h-4 w-4 shrink-0', className)} />
}
