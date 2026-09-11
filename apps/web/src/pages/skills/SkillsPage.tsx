import { useCallback, useEffect, useState } from 'react'
import { BookOpen, Plus } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { Badge, Button, EmptyState, Skeleton, Textarea } from '../../components/ui'
import {
  createSkill as apiCreateSkill,
  deleteSkill as apiDeleteSkill,
  getSkill as apiGetSkill,
  listSkills as apiListSkills,
  trialSkill as apiTrialSkill,
  updateSkill as apiUpdateSkill,
  type SkillDetail,
  type SkillInfo,
  type SkillTrial,
} from '../../lib/api'
import { statusPill, trialWords, usesWords } from './skillsFormat'

/**
 * Skills (S17): the procedures this household has written down, where they
 * came from, and the record of whether reading one helped.
 *
 * Read straight off GET /api/v1/skills. Everything beyond a row's own columns
 * is derived by the server at the request and shown as returned — a file
 * checked at the call, a source turn that retention swept, a ledger whose
 * unwatched uses stay a separate number from its clean ones.
 *
 * What this page deliberately does NOT do: claim a skill is good. The trial
 * runs the same request with the procedure and without it and prints what the
 * two turns did, one run each. Activation is the owner's click.
 */
export interface SkillsApi {
  listSkills: typeof apiListSkills
  getSkill: typeof apiGetSkill
  createSkill: typeof apiCreateSkill
  updateSkill: typeof apiUpdateSkill
  deleteSkill: typeof apiDeleteSkill
  trialSkill: typeof apiTrialSkill
}

const DEFAULT_API: SkillsApi = {
  listSkills: apiListSkills,
  getSkill: apiGetSkill,
  createSkill: apiCreateSkill,
  updateSkill: apiUpdateSkill,
  deleteSkill: apiDeleteSkill,
  trialSkill: apiTrialSkill,
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function SkillsPage({ api = DEFAULT_API }: { api?: SkillsApi } = {}) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openName, setOpenName] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setSkills(await api.listSkills())
      setError(null)
    } catch (err) {
      setError(reasonOf(err))
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div>
      <PageHeader
        title="Skills"
        description="Procedures written down from what worked before. She is told their names and reads one by asking for it, so every use is on the trace."
        actions={
          <Button size="sm" icon={<Plus size={12} />} onClick={() => setCreating(true)}>
            New skill
          </Button>
        }
      />

      {error && (
        <div
          role="alert"
          className="mb-6 rounded-sm border border-danger/30 bg-danger-dim px-4 py-3 text-compact text-danger"
        >
          Could not load skills: {error}
        </div>
      )}

      {creating && (
        <NewSkill
          api={api}
          onClose={() => setCreating(false)}
          onCreated={name => {
            setCreating(false)
            setOpenName(name)
            void refresh()
          }}
        />
      )}

      {skills === null ? (
        !error && (
          <div data-testid="skills-skeleton">
            <Skeleton lines={3} />
          </div>
        )
      ) : skills.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="Nothing written down yet"
          description="The hourly beat proposes one when it finds a procedure walked more than once, and it lands in the Inbox. You can also write one here."
          action={{ label: 'New skill', onClick: () => setCreating(true) }}
        />
      ) : (
        <ul className="space-y-2" data-testid="skills-list">
          {skills.map(skill => (
            <li
              key={skill.name}
              className="rounded-lg border border-border glass-card dark:border-white/[0.08]"
            >
              <button
                type="button"
                className="flex w-full items-start justify-between gap-4 px-4 py-3 text-left"
                onClick={() => setOpenName(openName === skill.name ? null : skill.name)}
              >
                <span>
                  <span className="block font-medium text-content-primary">{skill.name}</span>
                  <span className="block text-compact text-content-secondary">
                    {skill.summary ?? 'A file under skills/ that nobody has made a row for.'}
                  </span>
                  <span className="block text-caption text-content-tertiary">
                    {usesWords(skill.uses)}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {!skill.file_present && (
                    <Badge size="sm" color="danger">
                      File missing
                    </Badge>
                  )}
                  <Badge size="sm" color={statusPill(skill.status).color}>
                    {statusPill(skill.status).label}
                  </Badge>
                </span>
              </button>
              {openName === skill.name && skill.status !== null && (
                <SkillDetailPanel api={api} name={skill.name} onChanged={refresh} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The form for writing one by hand. A draft either way: a procedure nobody
 * has read is not one she has been given. */
function NewSkill({
  api,
  onClose,
  onCreated,
}: {
  api: SkillsApi
  onClose: () => void
  onCreated: (name: string) => void
}) {
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      data-testid="new-skill"
      className="mb-6 space-y-3 rounded-lg border border-border p-4 glass-card dark:border-white/[0.08]"
      onSubmit={async event => {
        event.preventDefault()
        try {
          const made = await api.createSkill({ name, title, summary, body })
          onCreated(made.name)
        } catch (err) {
          setError(reasonOf(err))
        }
      }}
    >
      {error && (
        <p role="alert" className="text-compact text-danger">
          {error}
        </p>
      )}
      <input
        aria-label="Name"
        placeholder="clear-superseded-notes"
        className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-compact"
        value={name}
        onChange={e => setName(e.target.value)}
      />
      <input
        aria-label="Title"
        placeholder="What it is"
        className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-compact"
        value={title}
        onChange={e => setTitle(e.target.value)}
      />
      <input
        aria-label="Summary"
        placeholder="When it applies — this is the line she is shown"
        className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-compact"
        value={summary}
        onChange={e => setSummary(e.target.value)}
      />
      <Textarea
        aria-label="Procedure"
        rows={6}
        value={body}
        onChange={e => setBody(e.target.value)}
      />
      <div className="flex gap-2">
        <Button size="sm" type="submit">
          Create draft
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

const MOVES: { to: 'active' | 'retired' | 'draft'; label: string }[] = [
  { to: 'active', label: 'Activate' },
  { to: 'draft', label: 'Back to draft' },
  { to: 'retired', label: 'Retire' },
]

function SkillDetailPanel({
  api,
  name,
  onChanged,
}: {
  api: SkillsApi
  name: string
  onChanged: () => void
}) {
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [trial, setTrial] = useState<SkillTrial | null>(null)
  const [trialling, setTrialling] = useState(false)

  const load = useCallback(async () => {
    try {
      const read = await api.getSkill(name)
      setDetail(read)
      setBody(read.body ?? '')
      setError(null)
    } catch (err) {
      setError(reasonOf(err))
    }
  }, [api, name])

  useEffect(() => {
    void load()
  }, [load])

  if (error) {
    return (
      <p role="alert" className="px-4 pb-4 text-compact text-danger">
        {error}
      </p>
    )
  }
  if (detail === null) return <div className="px-4 pb-4"><Skeleton lines={2} /></div>

  return (
    <div className="space-y-4 border-t border-border-subtle px-4 py-4" data-testid="skill-detail">
      {detail.flagged_reason && (
        <p role="status" className="text-compact text-warning" data-testid="flagged-reason">
          {detail.flagged_reason}
        </p>
      )}

      <div>
        <p className="text-caption uppercase tracking-wider text-content-tertiary">Steps taken</p>
        <p className="text-compact text-content-secondary">
          {detail.step_names.length === 0
            ? 'Written by hand, so there is no traced sequence behind it.'
            : detail.step_names.join(' → ')}
        </p>
      </div>

      <div>
        <p className="text-caption uppercase tracking-wider text-content-tertiary">Where it came from</p>
        {detail.source_turns.length === 0 ? (
          <p className="text-compact text-content-secondary">Written by hand.</p>
        ) : (
          <ul className="text-compact text-content-secondary">
            {detail.source_turns.map(turn => (
              <li key={turn.id}>
                {turn.present ? (
                  <a className="underline" href={`/activity?turn=${turn.id}`}>
                    {turn.id}
                  </a>
                ) : (
                  // Retention swept it. Said plainly, because a provenance
                  // link that 404s reads as a bug rather than as history.
                  <span>{turn.id} — this turn has aged out of the ledger</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Textarea
        aria-label="Procedure"
        rows={10}
        value={body}
        onChange={e => setBody(e.target.value)}
      />

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={async () => {
            try {
              await api.updateSkill(name, { body })
              await load()
              onChanged()
            } catch (err) {
              setError(reasonOf(err))
            }
          }}
        >
          Save
        </Button>
        {MOVES.filter(move => move.to !== detail.status).map(move => (
          <Button
            key={move.to}
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                await api.updateSkill(name, { status: move.to })
                await load()
                onChanged()
              } catch (err) {
                setError(reasonOf(err))
              }
            }}
          >
            {move.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          disabled={trialling}
          onClick={async () => {
            setTrialling(true)
            try {
              setTrial(await api.trialSkill(name))
            } catch (err) {
              setError(reasonOf(err))
            } finally {
              setTrialling(false)
            }
          }}
        >
          {trialling ? 'Running both turns…' : 'Trial it'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            try {
              await api.deleteSkill(name)
              onChanged()
            } catch (err) {
              setError(reasonOf(err))
            }
          }}
        >
          Delete
        </Button>
      </div>

      {trial && (
        <div className="rounded-sm border border-border-subtle p-3" data-testid="skill-trial">
          <p className="text-compact text-content-primary">
            {trialWords(trial.sides.with.calls, trial.sides.without.calls)}
          </p>
          <p className="text-caption text-content-tertiary">
            Ran “{trial.message}” twice on {trial.model}. With the procedure she{' '}
            {trial.sides.with.read_the_skill ? 'read it' : 'did not read it'}.
          </p>
          <p className="text-caption text-content-tertiary">
            One run each side, so this says what these two turns did — not that one way is better.
          </p>
        </div>
      )}
    </div>
  )
}
