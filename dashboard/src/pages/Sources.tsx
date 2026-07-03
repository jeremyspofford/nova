import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Globe, Lightbulb, Plus, Rss, Users } from 'lucide-react'
import { getKnowledgeSources, getKnowledgeStats, getIntelStats, getIntelRecommendations, updateRecommendation, type KnowledgeSource, type IntelRecommendation } from '../api'
import { useTabHash } from '../hooks/useTabHash'
import { useToast } from '../components/ToastProvider'
import { PageHeader } from '../components/layout/PageHeader'
import { Badge, Card, Metric, Tabs, Button, EmptyState, Skeleton } from '../components/ui'
import { SourceCard } from '../components/sources/SourceCard'
import { AddSourceModal } from '../components/sources/AddSourceModal'
import { CredentialManager } from '../components/sources/CredentialManager'
import { FeedStatusBar } from '../components/intel/FeedStatusBar'
import { FeedManagerModal } from '../components/intel/FeedManagerModal'
import { RecommendationCard } from '../components/intel/RecommendationCard'

type SourceTab = 'personal' | 'feeds' | 'shared' | 'recommendations'

const SOURCE_TABS: { id: SourceTab; label: string; icon: typeof Globe }[] = [
  { id: 'personal', label: 'Personal', icon: Globe },
  { id: 'feeds', label: 'Feeds', icon: Rss },
  { id: 'shared', label: 'Shared', icon: Users },
  { id: 'recommendations', label: 'Recommendations', icon: Lightbulb },
]

const HELP_ENTRIES = [
  { term: 'Personal Sources', definition: 'Websites, GitHub profiles, and docs you want Nova to learn from. Crawled automatically and ingested into Nova\'s memory.' },
  { term: 'Feeds', definition: 'RSS, Hacker News, Reddit, or GitHub sources that Nova monitors for new content and grades as recommendations.' },
  { term: 'Shared Sources', definition: 'Knowledge sources visible to all users. Admin-managed.' },
  { term: 'Credentials', definition: 'API tokens and keys used to authenticate with private sources (e.g., GitHub PATs for private repos).' },
  { term: 'Crawl', definition: 'Fetches the source URL, extracts relevant content, and ingests it into Nova\'s memory.' },
  { term: 'Intelligence', definition: 'Automated feed scanning that discovers relevant tools, libraries, and techniques, then grades them for Nova\'s use.' },
  { term: 'Grade', definition: 'A = strong recommendation (high confidence), B = worth considering, C = low confidence or niche.' },
  { term: 'Approve', definition: 'Mark a recommendation for implementation. Nova may create a goal from it.' },
  { term: 'Defer', definition: 'Postpone a recommendation for later review without dismissing it.' },
]

export function Sources() {
  const [activeTab, setActiveTab] = useTabHash<SourceTab>('personal', ['personal', 'feeds', 'shared', 'recommendations'])
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [feedManagerOpen, setFeedManagerOpen] = useState(false)

  // Stats queries
  const { data: knowledgeStats, isLoading: knowledgeStatsLoading } = useQuery({
    queryKey: ['knowledge-stats'],
    queryFn: getKnowledgeStats,
    staleTime: 10_000,
  })

  const { data: intelStats, isLoading: intelStatsLoading } = useQuery({
    queryKey: ['intel-stats'],
    queryFn: getIntelStats,
    staleTime: 30_000,
  })

  const { data: pendingRecs = [] } = useQuery({
    queryKey: ['intel-recs', 'pending'],
    queryFn: () => getIntelRecommendations({ status: 'pending' }),
    staleTime: 10_000,
  })

  const pendingRecCount = pendingRecs.length
  const statsLoading = knowledgeStatsLoading || intelStatsLoading

  const totalSources = (knowledgeStats?.total_sources ?? 0) + (intelStats?.active_feeds ?? 0)
  const activeSources = (knowledgeStats?.sources_by_status?.active ?? 0) + (intelStats?.active_feeds ?? 0)
  const totalCredentials = knowledgeStats?.total_credentials ?? 0

  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge"
        description="Knowledge sources and intelligence feeds powering Nova's memory"
        helpEntries={HELP_ENTRIES}
        actions={
          activeTab === 'feeds' || activeTab === 'recommendations' ? (
            <Button
              variant="secondary"
              icon={<Rss size={14} />}
              onClick={() => setFeedManagerOpen(true)}
            >
              Manage Feeds
            </Button>
          ) : (
            <Button
              variant="secondary"
              icon={<Plus size={14} />}
              onClick={() => setAddModalOpen(true)}
            >
              Add Source
            </Button>
          )
        }
      />

      {/* Pending recommendations banner */}
      {pendingRecCount > 0 && activeTab !== 'recommendations' && (
        <button
          onClick={() => setActiveTab('recommendations')}
          className="flex items-center gap-2 w-full rounded-md border border-accent/20 bg-accent/5 px-4 py-2.5 text-left transition-colors hover:bg-accent/10"
        >
          <Lightbulb size={16} className="text-accent shrink-0" />
          <span className="text-compact text-content-secondary">
            <strong className="text-accent">{pendingRecCount}</strong> new recommendation{pendingRecCount !== 1 ? 's' : ''} waiting for review
          </span>
          <ChevronRight size={14} className="ml-auto text-content-tertiary" />
        </button>
      )}

      {/* Tabs */}
      <Tabs
        tabs={SOURCE_TABS}
        activeTab={activeTab}
        onChange={(id) => setActiveTab(id as SourceTab)}
      />

      {/* Tab content */}
      {activeTab === 'personal' && (
        <PersonalTab onAddSource={() => setAddModalOpen(true)} />
      )}
      {activeTab === 'feeds' && (
        <FeedsTab onManageFeeds={() => setFeedManagerOpen(true)} />
      )}
      {activeTab === 'shared' && (
        <SharedTab onAddSource={() => setAddModalOpen(true)} />
      )}
      {activeTab === 'recommendations' && (
        <RecommendationsTab onManageFeeds={() => setFeedManagerOpen(true)} />
      )}

      {/* Stats row */}
      {statsLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="p-4">
              <Skeleton lines={2} />
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <Card className="p-4">
            <Metric
              label="Total Sources"
              value={totalSources}
              icon={<Globe size={12} />}
              tooltip="Knowledge sources plus active intel feeds."
            />
          </Card>
          <Card className="p-4">
            <Metric
              label="Active"
              value={activeSources}
              tooltip="Sources and feeds currently being monitored."
            />
          </Card>
          <Card className="p-4">
            <Metric
              label="Credentials"
              value={totalCredentials}
              tooltip="Stored authentication tokens for private sources."
            />
          </Card>
        </div>
      )}

      {/* Credentials section */}
      <CredentialManager />

      {/* Modals */}
      <AddSourceModal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        scope={activeTab === 'shared' ? 'shared' : 'personal'}
      />
      <FeedManagerModal open={feedManagerOpen} onClose={() => setFeedManagerOpen(false)} />
    </div>
  )
}

// ── Tab components ─────────────────────────────────────────────────────────────

function PersonalTab({ onAddSource }: { onAddSource: () => void }) {
  const { data: sources = [], isLoading } = useQuery({
    queryKey: ['knowledge-sources', 'personal'],
    queryFn: () => getKnowledgeSources({ scope: 'personal' }),
    staleTime: 5_000,
  })

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="p-4">
            <Skeleton lines={3} />
          </Card>
        ))}
      </div>
    )
  }

  if (sources.length === 0) {
    return (
      <EmptyState
        icon={Globe}
        title="No personal sources yet"
        description="Add a website, GitHub profile, or documentation URL to start building Nova's knowledge."
        action={{ label: 'Add Source', onClick: onAddSource }}
      />
    )
  }

  return (
    <div className="space-y-3">
      {sources.map((source: KnowledgeSource) => (
        <SourceCard key={source.id} source={source} />
      ))}
    </div>
  )
}

function FeedsTab({ onManageFeeds }: { onManageFeeds: () => void }) {
  return (
    <div className="space-y-4">
      <FeedStatusBar onManageFeeds={onManageFeeds} />
    </div>
  )
}

function SharedTab({ onAddSource }: { onAddSource: () => void }) {
  const { data: sources = [], isLoading } = useQuery({
    queryKey: ['knowledge-sources', 'shared'],
    queryFn: () => getKnowledgeSources({ scope: 'shared' }),
    staleTime: 5_000,
  })

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="p-4">
            <Skeleton lines={3} />
          </Card>
        ))}
      </div>
    )
  }

  if (sources.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No shared sources yet"
        description="Add sources visible to all users. Useful for team documentation and shared knowledge bases."
        action={{ label: 'Add Shared Source', onClick: onAddSource }}
      />
    )
  }

  return (
    <div className="space-y-3">
      {sources.map((source: KnowledgeSource) => (
        <SourceCard key={source.id} source={source} />
      ))}
    </div>
  )
}

// ── Recommendations tab ───────────────────────────────────────────────────────

type StatusFilter = 'pending' | 'approved' | 'deferred' | 'implemented' | 'all'

const STATUS_TABS: { id: StatusFilter; label: string }[] = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'deferred', label: 'Deferred' },
  { id: 'implemented', label: 'Implemented' },
  { id: 'all', label: 'All' },
]

function RecommendationsTab({ onManageFeeds }: { onManageFeeds: () => void }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['intel-stats'],
    queryFn: getIntelStats,
    staleTime: 30_000,
  })

  const { data: recs = [], isLoading: recsLoading } = useQuery({
    queryKey: ['intel-recs', statusFilter],
    queryFn: () => getIntelRecommendations(
      statusFilter === 'all' ? {} : { status: statusFilter },
    ),
    staleTime: 10_000,
  })

  const navigate = useNavigate()
  const { addToast } = useToast()

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      updateRecommendation(id, { status }),
    onSuccess: (_rec, { status }) => {
      qc.invalidateQueries({ queryKey: ['intel-recs'] })
      qc.invalidateQueries({ queryKey: ['intel-stats'] })
      if (status === 'approved') {
        qc.invalidateQueries({ queryKey: ['goals'] })
        qc.invalidateQueries({ queryKey: ['goal-stats'] })
        addToast({
          variant: 'success',
          message: 'Goal created from recommendation',
          action: { label: 'View goal', onClick: () => navigate('/goals') },
        })
      } else if (status === 'deferred') {
        addToast({ variant: 'info', message: 'Recommendation deferred' })
      } else if (status === 'dismissed') {
        addToast({ variant: 'info', message: 'Recommendation declined' })
      }
    },
    onError: (err) => {
      addToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Failed to update recommendation',
      })
    },
  })

  const handleStatusChange = (id: string) => (status: string) => {
    statusMutation.mutate({ id, status })
  }

  return (
    <div className="space-y-4">
      {/* Intel stats */}
      {statsLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i} className="p-4">
              <Skeleton lines={2} />
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <Card className="p-4">
            <Metric
              label="This Week"
              value={stats?.items_this_week ?? 0}
              tooltip="New content items discovered across all feeds in the past 7 days."
            />
          </Card>
          <Card className="p-4">
            <Metric
              label="Active Feeds"
              value={stats?.active_feeds ?? 0}
              icon={<Rss size={12} />}
              tooltip="Number of feeds currently being monitored."
            />
          </Card>
          <Card className="p-4">
            <Metric
              label="Grade A"
              value={stats?.grade_a ?? 0}
              tooltip="High-confidence recommendations worth implementing."
            />
          </Card>
          <Card className="p-4">
            <Metric
              label="Grade B"
              value={stats?.grade_b ?? 0}
              tooltip="Moderate-confidence recommendations worth considering."
            />
          </Card>
          <Card className="p-4">
            <Metric
              label="Total Recs"
              value={stats?.total_recommendations ?? 0}
              tooltip="Total recommendations generated across all time."
            />
          </Card>
        </div>
      )}

      {/* Feed status */}
      <FeedStatusBar onManageFeeds={onManageFeeds} />

      {/* Status filter sub-tabs */}
      <Tabs
        tabs={STATUS_TABS}
        activeTab={statusFilter}
        onChange={(id) => setStatusFilter(id as StatusFilter)}
      />

      {/* Recommendation list */}
      {recsLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="p-4">
              <Skeleton lines={4} />
            </Card>
          ))}
        </div>
      ) : recs.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title={statusFilter === 'all' ? 'No recommendations yet' : `No ${statusFilter} recommendations`}
          description={
            statusFilter === 'all'
              ? 'Add feeds to start discovering recommendations.'
              : 'Try selecting a different filter.'
          }
          action={
            statusFilter === 'all'
              ? { label: 'Manage Feeds', onClick: onManageFeeds }
              : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {recs.map((rec: IntelRecommendation) => (
            <RecommendationCard
              key={rec.id}
              rec={rec}
              expanded={expandedId === rec.id}
              onToggle={() => setExpandedId(prev => prev === rec.id ? null : rec.id)}
              onStatusChange={handleStatusChange(rec.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
