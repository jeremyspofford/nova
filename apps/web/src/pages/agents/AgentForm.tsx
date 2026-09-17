import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { Badge, Button, Checkbox, Input, Sheet, Skeleton, Textarea, Toggle } from '../../components/ui'
import {
  listSkills as apiListSkills,
  listTools as apiListTools,
  type Agent,
  type AgentChanges,
  type AgentSaved,
  type AgentWrite,
  type SkillInfo,
  type ToolInfo,
} from '../../lib/api'

/**
 * The one form both agent pages open in a Sheet — "New agent" on the roster,
 * Edit on the agent's own page. The lists it offers (tools, skills) are read
 * from core AT THE MOMENT it opens (the live registry, the skills directory),
 * never a copy: a tool registered later is offered by that fact alone.
 *
 * Nothing here decides anything. The store validates the spec and refuses in
 * its own words; a refusal is shown inline, verbatim, and the sheet stays
 * open with the draft intact. Success is the row the server read back after
 * its commit — handed to the caller as `onSaved`, never assumed from the
 * draft.
 *
 * `delegate_to_agent` is hidden from the tool list: an agent cannot delegate
 * (core refuses it inside an agent turn), so offering it would be offering a
 * call that cannot run. An entry the agent already holds that the registry
 * no longer lists is shown FLAGGED ("no longer exists"), still ticked, so the
 * owner can see it and untick it — never silently dropped from the spec.
 */
export interface AgentFormApi {
  listTools: typeof apiListTools
  listSkills: typeof apiListSkills
}

const DEFAULT_API: AgentFormApi = { listTools: apiListTools, listSkills: apiListSkills }

/** The one tool never offered: delegation is Nova's, not an agent's. */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set(['delegate_to_agent'])

export const MAX_TOOL_ROUNDS = 50

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const bannerClass =
  'rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger'

interface Draft {
  name: string
  purpose: string
  instructions: string
  tools: string[]
  skills: string[]
  /** As typed; '' = uncapped. Parsed only on submit. */
  cap: string
  /** As typed; '' = the store's default. Parsed only on submit. */
  rounds: string
  readShared: boolean
}

function draftFrom(initial: Agent | undefined): Draft {
  if (!initial) {
    return { name: '', purpose: '', instructions: '', tools: [], skills: [], cap: '', rounds: '', readShared: false }
  }
  return {
    name: initial.name,
    purpose: initial.purpose,
    instructions: initial.instructions,
    tools: [...initial.tools],
    skills: initial.skills.map(s => s.name),
    cap: initial.monthly_cap_usd === null ? '' : String(initial.monthly_cap_usd),
    rounds: String(initial.max_tool_rounds),
    readShared: initial.read_shared_memory,
  }
}

/** What the draft sends. Numbers are parsed here and nowhere else; a blank
 * cap is null (uncapped) and a blank rounds field is OMITTED so the store
 * applies its own default rather than this client guessing one. */
export function bodyFrom(draft: Draft): AgentWrite {
  const body: AgentWrite = {
    name: draft.name.trim(),
    purpose: draft.purpose.trim(),
    instructions: draft.instructions,
    tools: draft.tools,
    skills: draft.skills,
    monthly_cap_usd: draft.cap.trim() === '' ? null : Number(draft.cap),
    read_shared_memory: draft.readShared,
  }
  if (draft.rounds.trim() !== '') body.max_tool_rounds = Number(draft.rounds)
  return body
}

function toggleName(list: string[], name: string, on: boolean): string[] {
  if (on) return list.includes(name) ? list : [...list, name]
  return list.filter(n => n !== name)
}

export function AgentForm({
  open,
  onClose,
  initial,
  onSave,
  onSaved,
  api = DEFAULT_API,
}: {
  open: boolean
  onClose: () => void
  /** The agent being edited; absent = create. The name is locked on edit. */
  initial?: Agent
  /** The write: create (no initial) or update. Throws with the store's words. */
  onSave: (body: AgentWrite, changes: AgentChanges) => Promise<AgentSaved>
  onSaved: (saved: AgentSaved) => void
  api?: AgentFormApi
}) {
  return (
    <Sheet open={open} onClose={onClose} width="wide" title={initial ? `Edit ${initial.name}` : 'New agent'}>
      {/* Mounted fresh each time the sheet opens, so the draft starts from
          `initial` as it was THEN and a roster poll re-reading the agent
          mid-edit cannot reset what the owner is typing. */}
      {open && <AgentFormBody initial={initial} onClose={onClose} onSave={onSave} onSaved={onSaved} api={api} />}
    </Sheet>
  )
}

function AgentFormBody({
  initial,
  onClose,
  onSave,
  onSaved,
  api,
}: {
  initial?: Agent
  onClose: () => void
  onSave: (body: AgentWrite, changes: AgentChanges) => Promise<AgentSaved>
  onSaved: (saved: AgentSaved) => void
  api: AgentFormApi
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial))
  const [tools, setTools] = useState<ToolInfo[] | null>(null)
  const [toolsError, setToolsError] = useState<string | null>(null)
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [skillsError, setSkillsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.listTools().then(
      rows => live && setTools(rows),
      err => live && setToolsError(reasonOf(err)),
    )
    api.listSkills().then(
      rows => live && setSkills(rows),
      err => live && setSkillsError(reasonOf(err)),
    )
    return () => {
      live = false
    }
  }, [api])

  const offeredTools = useMemo(() => (tools ?? []).filter(t => !HIDDEN_TOOLS.has(t.name)), [tools])
  const offeredToolNames = useMemo(() => new Set(offeredTools.map(t => t.name)), [offeredTools])
  // Entries the draft holds that the registry no longer lists. While the
  // registry could not be read, the server's own `unknown_tools` (derived
  // against the registry at the last read) is the only fact to go on.
  const staleTools = useMemo(() => {
    if (tools === null) return initial ? initial.unknown_tools.filter(n => draft.tools.includes(n)) : []
    return draft.tools.filter(n => !offeredToolNames.has(n) && !HIDDEN_TOOLS.has(n))
  }, [tools, initial, draft.tools, offeredToolNames])

  const offeredSkillNames = useMemo(() => new Set((skills ?? []).map(s => s.name)), [skills])
  const missingSkills = useMemo(() => {
    if (skills === null) return initial ? initial.skills.filter(s => !s.present && draft.skills.includes(s.name)).map(s => s.name) : []
    return draft.skills.filter(n => !offeredSkillNames.has(n))
  }, [skills, initial, draft.skills, offeredSkillNames])

  const roundsNumber = draft.rounds.trim() === '' ? null : Number(draft.rounds)
  const roundsBad =
    roundsNumber !== null && (!Number.isInteger(roundsNumber) || roundsNumber < 1 || roundsNumber > MAX_TOOL_ROUNDS)
  const capNumber = draft.cap.trim() === '' ? null : Number(draft.cap)
  const capBad = capNumber !== null && (!Number.isFinite(capNumber) || capNumber < 0)
  const canSubmit =
    !saving && !roundsBad && !capBad && draft.name.trim() !== '' && draft.purpose.trim() !== '' && draft.instructions.trim() !== ''

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const body = bodyFrom(draft)
      // A PUT is the same spec minus the immutable name (the store refuses a
      // rename in its own words, so it is never sent).
      const { name: _name, ...changes } = body
      void _name
      const saved = await onSave(body, changes)
      onSaved(saved)
    } catch (err) {
      // The store's refusal, verbatim — the sheet stays open, draft intact.
      setSaveError(reasonOf(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      data-testid="agent-form"
      className="px-5 py-4 space-y-4"
      onSubmit={e => {
        e.preventDefault()
        if (canSubmit) void save()
      }}
    >
      <Input
        label="Name"
        description={initial ? 'A name is for life — it is the routing role and the folder.' : 'Lowercase, a routing role (agent_<name>) and a folder (agents/<name>/) are derived from it.'}
        value={draft.name}
        onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
        placeholder="coder"
        disabled={initial !== undefined}
        readOnly={initial !== undefined}
        required
      />
      <Input
        label="Purpose"
        description="One line: what it is for. Nova reads this to decide when to hand it work."
        value={draft.purpose}
        onChange={e => setDraft(d => ({ ...d, purpose: e.target.value }))}
        placeholder="writes and reviews code in the workspace"
        required
      />
      <Textarea
        label="Instructions"
        description="Its standing brief — how it works, what it must and must not do."
        value={draft.instructions}
        onChange={e => setDraft(d => ({ ...d, instructions: e.target.value }))}
        autoResize={false}
        rows={6}
        required
      />

      <fieldset>
        <legend className="mb-1.5 block text-caption font-medium text-content-secondary">Tools</legend>
        <p className="mb-2 text-caption text-content-tertiary">
          The subset it may call, from the live registry. Delegation is Nova's alone and is not offered.
        </p>
        {tools === null && !toolsError && <Skeleton lines={3} />}
        {toolsError && (
          <p role="alert" className="text-caption text-danger">
            Could not read the tool registry: {toolsError}
          </p>
        )}
        <div className="space-y-1.5" data-testid="agent-form-tools">
          {staleTools.map(name => (
            <div key={name} className="flex items-center gap-2" data-testid={`tool-stale-${name}`}>
              <Checkbox
                id={`tool-${name}`}
                label={name}
                checked={draft.tools.includes(name)}
                onChange={on => setDraft(d => ({ ...d, tools: toggleName(d.tools, name, on) }))}
              />
              <Badge size="sm" color="warning">
                <AlertTriangle size={10} /> no longer exists
              </Badge>
            </div>
          ))}
          {offeredTools.map(tool => (
            <Checkbox
              key={tool.name}
              id={`tool-${tool.name}`}
              label={tool.name}
              description={tool.description}
              checked={draft.tools.includes(tool.name)}
              onChange={on => setDraft(d => ({ ...d, tools: toggleName(d.tools, tool.name, on) }))}
            />
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1.5 block text-caption font-medium text-content-secondary">Skills</legend>
        <p className="mb-2 text-caption text-content-tertiary">
          Files under <span className="font-mono">skills/</span> in the workspace, read into its prompt.
        </p>
        {skills === null && !skillsError && <Skeleton lines={2} />}
        {skillsError && (
          <p role="alert" className="text-caption text-danger">
            Could not read the skills directory: {skillsError}
          </p>
        )}
        <div className="space-y-1.5" data-testid="agent-form-skills">
          {missingSkills.map(name => (
            <div key={name} className="flex items-center gap-2" data-testid={`skill-missing-${name}`}>
              <Checkbox
                id={`skill-${name}`}
                label={name}
                checked={draft.skills.includes(name)}
                onChange={on => setDraft(d => ({ ...d, skills: toggleName(d.skills, name, on) }))}
              />
              <Badge size="sm" color="warning">
                <AlertTriangle size={10} /> missing
              </Badge>
            </div>
          ))}
          {(skills ?? []).map(skill => (
            <Checkbox
              key={skill.name}
              id={`skill-${skill.name}`}
              label={skill.name}
              checked={draft.skills.includes(skill.name)}
              onChange={on => setDraft(d => ({ ...d, skills: toggleName(d.skills, skill.name, on) }))}
            />
          ))}
          {skills !== null && skills.length === 0 && missingSkills.length === 0 && (
            <p className="text-caption text-content-tertiary italic">No skill files yet.</p>
          )}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Monthly cap (USD)"
          description="Blank = uncapped. Over it, a turn stops before its first model call."
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          value={draft.cap}
          onChange={e => setDraft(d => ({ ...d, cap: e.target.value }))}
          error={capBad ? 'a cap is a non-negative amount' : undefined}
          placeholder="uncapped"
        />
        <Input
          label="Max tool rounds"
          description={`1–${MAX_TOOL_ROUNDS}. Blank = the default.`}
          type="number"
          min={1}
          max={MAX_TOOL_ROUNDS}
          step={1}
          inputMode="numeric"
          value={draft.rounds}
          onChange={e => setDraft(d => ({ ...d, rounds: e.target.value }))}
          error={roundsBad ? `rounds must be a whole number from 1 to ${MAX_TOOL_ROUNDS}` : undefined}
        />
      </div>

      <div>
        <Toggle
          label="Read shared memory"
          checked={draft.readShared}
          onChange={on => setDraft(d => ({ ...d, readShared: on }))}
        />
        <p className="mt-1 text-caption text-content-tertiary">
          lets it read the household's shared notes; it still writes only its own
        </p>
      </div>

      <p className="text-caption text-content-tertiary">
        Which model answers it is a routing chain:{' '}
        <Link to="/settings" className="inline-flex items-center gap-1 text-accent hover:underline">
          set its model chain on Settings → Routing <ExternalLink size={11} />
        </Link>
      </p>

      {saveError && (
        <div role="alert" className={bannerClass}>
          Not saved — {saveError}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" loading={saving} disabled={!canSubmit}>
          {initial ? 'Save changes' : 'Create agent'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
