import { useState } from 'react'
import { Search, Mail, Eye, EyeOff, Plus, Trash2, Activity, Settings, Inbox, HelpCircle, Home, Layers, Zap } from 'lucide-react'
import {
  Button,
  Input,
  Textarea,
  Select,
  Checkbox,
  Toggle,
  RadioGroup,
  Slider,
  Badge,
  Avatar,
  StatusDot,
  Code,
  CopyableId,
  Metric,
  ProgressBar,
  PipelineStages,
  Table,
  DataList,
  Card,
  Section,
  Modal,
  Sheet,
  Tabs,
  Accordion,
  EmptyState,
  Skeleton,
  Tooltip,
  Popover,
  ConfirmDialog,
  SearchInput,
  ModelPicker,
  Breadcrumb,
} from '../../components/ui'
import { useToast } from '../../components/ToastProvider'
import type { TableColumn } from '../../components/ui'

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="font-sans text-h2 text-content-primary mb-4">{children}</h2>
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-h4 text-content-secondary mb-3">{title}</h3>
      {children}
    </div>
  )
}

function DemoCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-surface-card p-6 space-y-4">
      {children}
    </div>
  )
}

// ── Button Gallery ─────────────────────────────────────────────────────────────

function ButtonGallery() {
  return (
    <div>
      <SectionTitle>Button</SectionTitle>
      <DemoCard>
        <SubSection title="Variants">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button>
            <Button variant="outline">Outline</Button>
          </div>
        </SubSection>

        <SubSection title="Sizes">
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
          </div>
        </SubSection>

        <SubSection title="With Icons">
          <div className="flex flex-wrap items-center gap-3">
            <Button icon={<Plus size={14} />}>Add Item</Button>
            <Button variant="danger" icon={<Trash2 size={14} />}>Delete</Button>
            <Button variant="secondary" icon={<Mail size={14} />}>Send</Button>
          </div>
        </SubSection>

        <SubSection title="Loading">
          <div className="flex flex-wrap items-center gap-3">
            <Button loading>Saving...</Button>
            <Button variant="secondary" loading>Loading</Button>
            <Button variant="danger" loading size="sm">Deleting</Button>
          </div>
        </SubSection>

        <SubSection title="Disabled">
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled>Disabled</Button>
            <Button variant="secondary" disabled>Disabled</Button>
            <Button variant="ghost" disabled>Disabled</Button>
          </div>
        </SubSection>
      </DemoCard>
    </div>
  )
}

// ── Input Gallery ──────────────────────────────────────────────────────────────

function InputGallery() {
  const [showPassword, setShowPassword] = useState(false)

  return (
    <div>
      <SectionTitle>Input</SectionTitle>
      <DemoCard>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <Input label="Email" placeholder="you@example.com" type="email" />
          <Input label="With description" placeholder="Type here..." description="This is helper text." />
          <Input label="Error state" placeholder="Invalid input" error="This field is required." />
          <Input
            label="With prefix"
            placeholder="Search..."
            prefix={<Search size={14} />}
          />
          <Input
            label="With suffix"
            type={showPassword ? 'text' : 'password'}
            placeholder="Password"
            suffix={
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="pointer-events-auto cursor-pointer text-content-tertiary hover:text-content-secondary"
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            }
          />
          <Input label="Disabled" placeholder="Cannot edit" disabled />
        </div>
      </DemoCard>
    </div>
  )
}

// ── Textarea Gallery ───────────────────────────────────────────────────────────

function TextareaGallery() {
  const [text, setText] = useState('')

  return (
    <div>
      <SectionTitle>Textarea</SectionTitle>
      <DemoCard>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <Textarea label="Description" placeholder="Tell us more..." rows={3} />
          <Textarea
            label="With character count"
            placeholder="Max 200 characters..."
            showCount
            maxLength={200}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
          />
          <Textarea label="Error state" error="Please provide more detail." rows={3} />
          <Textarea label="Disabled" placeholder="Cannot edit" disabled rows={3} />
        </div>
      </DemoCard>
    </div>
  )
}

// ── Select Gallery ─────────────────────────────────────────────────────────────

function SelectGallery() {
  const [val, setVal] = useState('option-1')

  return (
    <div>
      <SectionTitle>Select</SectionTitle>
      <DemoCard>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <Select
            label="With items prop"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            items={[
              { value: 'option-1', label: 'Option 1' },
              { value: 'option-2', label: 'Option 2' },
              { value: 'option-3', label: 'Option 3' },
            ]}
          />
          <Select label="With description" description="Pick your favorite." items={[
            { value: 'react', label: 'React' },
            { value: 'vue', label: 'Vue' },
            { value: 'svelte', label: 'Svelte' },
          ]} />
          <Select label="Error state" error="Selection is required." items={[
            { value: '', label: '-- Select --' },
            { value: 'a', label: 'Alpha' },
          ]} />
          <Select label="Disabled" disabled items={[
            { value: 'locked', label: 'Locked option' },
          ]} />
        </div>
      </DemoCard>
    </div>
  )
}

// ── Checkbox Gallery ───────────────────────────────────────────────────────────

function CheckboxGallery() {
  const [checks, setChecks] = useState({ a: true, b: false, c: false })

  return (
    <div>
      <SectionTitle>Checkbox</SectionTitle>
      <DemoCard>
        <div className="space-y-3">
          <Checkbox
            label="Accept terms"
            description="You agree to our Terms of Service and Privacy Policy."
            checked={checks.a}
            onChange={(v) => setChecks((p) => ({ ...p, a: v }))}
          />
          <Checkbox
            label="Enable notifications"
            checked={checks.b}
            onChange={(v) => setChecks((p) => ({ ...p, b: v }))}
          />
          <Checkbox
            label="Subscribe to updates"
            checked={checks.c}
            onChange={(v) => setChecks((p) => ({ ...p, c: v }))}
          />
          <Checkbox label="Disabled unchecked" disabled />
          <Checkbox label="Disabled checked" checked disabled />
        </div>
      </DemoCard>
    </div>
  )
}

// ── Toggle Gallery ─────────────────────────────────────────────────────────────

function ToggleGallery() {
  const [on1, setOn1] = useState(true)
  const [on2, setOn2] = useState(false)

  return (
    <div>
      <SectionTitle>Toggle</SectionTitle>
      <DemoCard>
        <div className="space-y-3">
          <Toggle label="Dark mode" checked={on1} onChange={setOn1} />
          <Toggle label="Notifications" checked={on2} onChange={setOn2} />
          <Toggle label="Small toggle" size="sm" checked onChange={() => {}} />
          <Toggle label="Disabled" disabled />
          <Toggle label="Disabled on" checked disabled />
        </div>
      </DemoCard>
    </div>
  )
}

// ── Radio Gallery ──────────────────────────────────────────────────────────────

function RadioGallery() {
  const [val, setVal] = useState('cloud-first')

  return (
    <div>
      <SectionTitle>RadioGroup</SectionTitle>
      <DemoCard>
        <RadioGroup
          name="routing"
          value={val}
          onChange={setVal}
          options={[
            { value: 'local-only', label: 'Local only', description: 'Only use local inference.' },
            { value: 'local-first', label: 'Local first', description: 'Prefer local, fall back to cloud.' },
            { value: 'cloud-first', label: 'Cloud first', description: 'Prefer cloud providers.' },
            { value: 'cloud-only', label: 'Cloud only', description: 'Only use cloud providers.' },
          ]}
        />
      </DemoCard>
    </div>
  )
}

// ── Slider Gallery ─────────────────────────────────────────────────────────────

function SliderGallery() {
  const [v1, setV1] = useState(50)
  const [v2, setV2] = useState(0.7)

  return (
    <div>
      <SectionTitle>Slider</SectionTitle>
      <DemoCard>
        <div className="space-y-6 max-w-md">
          <Slider label="Volume" value={v1} onChange={setV1} />
          <Slider label="Temperature" min={0} max={2} step={0.1} value={v2} onChange={setV2} />
          <Slider label="Disabled" value={30} disabled />
        </div>
      </DemoCard>
    </div>
  )
}

// ── Badge Gallery ──────────────────────────────────────────────────────────────

function BadgeGallery() {
  return (
    <div>
      <SectionTitle>Badge</SectionTitle>
      <DemoCard>
        <SubSection title="Colors">
          <div className="flex flex-wrap gap-2">
            <Badge color="neutral">neutral</Badge>
            <Badge color="accent">accent</Badge>
            <Badge color="success">success</Badge>
            <Badge color="warning">warning</Badge>
            <Badge color="danger">danger</Badge>
            <Badge color="info">info</Badge>
          </div>
        </SubSection>
        <SubSection title="Sizes">
          <div className="flex flex-wrap items-center gap-2">
            <Badge size="sm">small</Badge>
            <Badge size="md">medium</Badge>
          </div>
        </SubSection>
        <SubSection title="With Dot">
          <div className="flex flex-wrap gap-2">
            <Badge color="success" dot>online</Badge>
            <Badge color="warning" dot>degraded</Badge>
            <Badge color="danger" dot>offline</Badge>
            <Badge color="info" dot>syncing</Badge>
          </div>
        </SubSection>
      </DemoCard>
    </div>
  )
}

// ── Avatar Gallery ─────────────────────────────────────────────────────────────

function AvatarGallery() {
  return (
    <div>
      <SectionTitle>Avatar</SectionTitle>
      <DemoCard>
        <SubSection title="Sizes (Initials)">
          <div className="flex items-center gap-3">
            <Avatar name="Ada Lovelace" size="xs" />
            <Avatar name="Ada Lovelace" size="sm" />
            <Avatar name="Ada Lovelace" size="md" />
            <Avatar name="Ada Lovelace" size="lg" />
          </div>
        </SubSection>
        <SubSection title="With Status">
          <div className="flex items-center gap-3">
            <Avatar name="Online User" size="md" status="online" />
            <Avatar name="Busy User" size="md" status="busy" />
            <Avatar name="Offline User" size="md" status="offline" />
          </div>
        </SubSection>
        <SubSection title="Single Name">
          <div className="flex items-center gap-3">
            <Avatar name="Nova" size="md" />
            <Avatar name="X" size="md" />
          </div>
        </SubSection>
      </DemoCard>
    </div>
  )
}

// ── StatusDot Gallery ──────────────────────────────────────────────────────────

function StatusDotGallery() {
  return (
    <div>
      <SectionTitle>StatusDot</SectionTitle>
      <DemoCard>
        <SubSection title="Variants">
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5 text-compact text-content-secondary">
              <StatusDot status="success" /> Success
            </span>
            <span className="inline-flex items-center gap-1.5 text-compact text-content-secondary">
              <StatusDot status="warning" /> Warning
            </span>
            <span className="inline-flex items-center gap-1.5 text-compact text-content-secondary">
              <StatusDot status="danger" /> Danger
            </span>
            <span className="inline-flex items-center gap-1.5 text-compact text-content-secondary">
              <StatusDot status="neutral" /> Neutral
            </span>
          </div>
        </SubSection>
        <SubSection title="Sizes">
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5 text-compact text-content-secondary">
              <StatusDot status="success" size="sm" /> Small
            </span>
            <span className="inline-flex items-center gap-1.5 text-compact text-content-secondary">
              <StatusDot status="success" size="md" /> Medium
            </span>
            <span className="inline-flex items-center gap-1.5 text-compact text-content-secondary">
              <StatusDot status="success" size="lg" /> Large
            </span>
          </div>
        </SubSection>
        <SubSection title="Pulsing">
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5 text-compact text-content-secondary">
              <StatusDot status="success" pulse /> Active
            </span>
            <span className="inline-flex items-center gap-1.5 text-compact text-content-secondary">
              <StatusDot status="warning" pulse /> Processing
            </span>
          </div>
        </SubSection>
      </DemoCard>
    </div>
  )
}

// ── Code Gallery ───────────────────────────────────────────────────────────────

function CodeGallery() {
  return (
    <div>
      <SectionTitle>Code</SectionTitle>
      <DemoCard>
        <SubSection title="Inline">
          <p className="text-body text-content-secondary">
            Run <Code>npm install</Code> to get started, then <Code>npm run dev</Code> to launch.
          </p>
        </SubSection>
        <SubSection title="Block">
          <Code inline={false}>
            {'docker compose up --build\ncurl http://localhost:8000/health/ready'}
          </Code>
        </SubSection>
        <SubSection title="Block + Copyable">
          <Code inline={false} copyable>
            {'export NOVA_ADMIN_SECRET="your-secret-here"\ndocker compose up -d'}
          </Code>
        </SubSection>
      </DemoCard>
    </div>
  )
}

// ── CopyableId Gallery ─────────────────────────────────────────────────────────

function CopyableIdGallery() {
  return (
    <div>
      <SectionTitle>CopyableId</SectionTitle>
      <DemoCard>
        <SubSection title="Default (8 chars)">
          <CopyableId id="a1b2c3d4-e5f6-7890-abcd-ef1234567890" />
        </SubSection>
        <SubSection title="Custom truncation (12 chars)">
          <CopyableId id="sk-nova-abc123def456ghi789" truncate={12} />
        </SubSection>
        <SubSection title="Short ID (no truncation)">
          <CopyableId id="abc123" />
        </SubSection>
      </DemoCard>
    </div>
  )
}

// ── Metric Gallery ─────────────────────────────────────────────────────────────

function MetricGallery() {
  return (
    <div>
      <SectionTitle>Metric</SectionTitle>
      <DemoCard>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <Metric label="Total Tasks" value="1,284" change={{ value: '12%', direction: 'up' }} />
          <Metric label="Error Rate" value="0.3%" change={{ value: '0.1%', direction: 'down' }} />
          <Metric
            label="Latency"
            value="142ms"
            icon={<Activity size={12} />}
          />
        </div>
      </DemoCard>
    </div>
  )
}

// ── ProgressBar Gallery ────────────────────────────────────────────────────────

function ProgressBarGallery() {
  return (
    <div>
      <SectionTitle>ProgressBar</SectionTitle>
      <DemoCard>
        <SubSection title="Determinate">
          <div className="space-y-3 max-w-md">
            <ProgressBar value={25} />
            <ProgressBar value={50} />
            <ProgressBar value={75} />
            <ProgressBar value={100} />
          </div>
        </SubSection>
        <SubSection title="Sizes">
          <div className="space-y-3 max-w-md">
            <ProgressBar value={60} size="sm" />
            <ProgressBar value={60} size="md" />
          </div>
        </SubSection>
        <SubSection title="Indeterminate">
          <div className="space-y-3 max-w-md">
            <ProgressBar variant="indeterminate" />
            <ProgressBar variant="indeterminate" size="sm" />
          </div>
        </SubSection>
      </DemoCard>
    </div>
  )
}

// ── PipelineStages Gallery ─────────────────────────────────────────────────────

function PipelineStagesGallery() {
  return (
    <div>
      <SectionTitle>PipelineStages</SectionTitle>
      <DemoCard>
        <SubSection title="Compact">
          <div className="space-y-2">
            <PipelineStages stages={['done', 'done', 'active', 'pending', 'pending']} compact />
            <PipelineStages stages={['done', 'done', 'done', 'done', 'done']} compact />
            <PipelineStages stages={['done', 'done', 'failed', 'pending', 'pending']} compact />
          </div>
        </SubSection>
        <SubSection title="With Labels">
          <div className="space-y-4">
            <PipelineStages stages={['done', 'done', 'active', 'pending', 'pending']} />
            <PipelineStages stages={['done', 'done', 'done', 'done', 'done']} />
            <PipelineStages stages={['done', 'failed', 'pending', 'pending', 'pending']} />
          </div>
        </SubSection>
      </DemoCard>
    </div>
  )
}

// ── Table Gallery ──────────────────────────────────────────────────────────────

interface SampleRow {
  id: string
  name: string
  status: string
  latency: number
  [key: string]: unknown
}

const sampleData: SampleRow[] = [
  { id: 'task-001', name: 'Context Retrieval', status: 'completed', latency: 142 },
  { id: 'task-002', name: 'Code Review', status: 'running', latency: 0 },
  { id: 'task-003', name: 'Guardrail Check', status: 'failed', latency: 89 },
]

const sampleColumns: TableColumn<SampleRow>[] = [
  { key: 'id', header: 'ID', width: '120px' },
  { key: 'name', header: 'Task Name', sortable: true },
  {
    key: 'status',
    header: 'Status',
    sortable: true,
    render: (row) => (
      <Badge
        color={row.status === 'completed' ? 'success' : row.status === 'running' ? 'accent' : 'danger'}
        size="sm"
      >
        {row.status}
      </Badge>
    ),
  },
  {
    key: 'latency',
    header: 'Latency',
    sortable: true,
    render: (row) => <span className="font-mono text-mono-sm">{row.latency ? `${row.latency}ms` : '--'}</span>,
  },
]

function TableGallery() {
  return (
    <div>
      <SectionTitle>Table</SectionTitle>
      <DemoCard>
        <SubSection title="With Data">
          <Table columns={sampleColumns} data={sampleData} onRowClick={() => {}} />
        </SubSection>
        <SubSection title="Empty State">
          <Table columns={sampleColumns} data={[]} emptyMessage="No tasks found." />
        </SubSection>
      </DemoCard>
    </div>
  )
}

// ── DataList Gallery ───────────────────────────────────────────────────────────

function DataListGallery() {
  return (
    <div>
      <SectionTitle>DataList</SectionTitle>
      <DemoCard>
        <div className="max-w-md">
          <DataList
            items={[
              { label: 'Task ID', value: 'task-a1b2c3d4', copyable: true },
              { label: 'Status', value: <Badge color="success" size="sm">completed</Badge> },
              { label: 'Duration', value: '142ms' },
              { label: 'Model', value: 'claude-3-opus', copyable: true },
              { label: 'Tokens Used', value: '1,284' },
            ]}
          />
        </div>
      </DemoCard>
    </div>
  )
}

// ── Card Gallery ──────────────────────────────────────────────────────────────

function CardGallery() {
  return (
    <div>
      <SectionTitle>Card</SectionTitle>
      <DemoCard>
        <SubSection title="Variants">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card>
              <div className="p-4">
                <p className="text-compact text-content-primary">Default card</p>
                <p className="text-caption text-content-secondary mt-1">Subtle border, standard background.</p>
              </div>
            </Card>
            <Card variant="hoverable">
              <div className="p-4">
                <p className="text-compact text-content-primary">Hoverable card</p>
                <p className="text-caption text-content-secondary mt-1">Hover to see border + bg change.</p>
              </div>
            </Card>
            <Card variant="outlined">
              <div className="p-4">
                <p className="text-compact text-content-primary">Outlined card</p>
                <p className="text-caption text-content-secondary mt-1">Stronger border variant.</p>
              </div>
            </Card>
          </div>
        </SubSection>
        <SubSection title="With Header + Footer">
          <Card
            header={{ title: 'Pipeline Run #42', action: <span>View Details</span> }}
            footer={
              <>
                <Button variant="ghost" size="sm">Cancel</Button>
                <Button size="sm">Approve</Button>
              </>
            }
          >
            <div className="px-5 py-4">
              <p className="text-compact text-content-secondary">Card content goes here. Header and footer have built-in padding.</p>
            </div>
          </Card>
        </SubSection>
        <SubSection title="With Glow">
          <Card glow>
            <div className="p-4">
              <p className="text-compact text-content-primary">Glow card (hover me)</p>
              <p className="text-caption text-content-secondary mt-1">Uses the card-glow effect with accent top highlight.</p>
            </div>
          </Card>
        </SubSection>
      </DemoCard>
    </div>
  )
}

// ── Section Gallery ──────────────────────────────────────────────────────────

function SectionGallery() {
  return (
    <div>
      <SectionTitle>Section</SectionTitle>
      <DemoCard>
        <SubSection title="Default">
          <Section icon={Settings} title="General Settings" description="Core configuration for the platform.">
            <p className="text-compact text-content-secondary">Section content goes here.</p>
          </Section>
        </SubSection>
        <SubSection title="Collapsible">
          <Section icon={Layers} title="Advanced Options" description="Click to expand/collapse." collapsible defaultOpen={false}>
            <p className="text-compact text-content-secondary">This content is hidden by default. Click the header to reveal it.</p>
          </Section>
        </SubSection>
      </DemoCard>
    </div>
  )
}

// ── Modal & Sheet Gallery ────────────────────────────────────────────────────

function ModalSheetGallery() {
  const [modalOpen, setModalOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <div>
      <SectionTitle>Modal, Sheet, ConfirmDialog</SectionTitle>
      <DemoCard>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => setModalOpen(true)}>Open Modal</Button>
          <Button variant="secondary" onClick={() => setSheetOpen(true)}>Open Sheet</Button>
          <Button variant="danger" onClick={() => setConfirmOpen(true)}>Confirm Delete</Button>
        </div>

        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title="Example Modal"
          footer={
            <>
              <Button variant="ghost" onClick={() => setModalOpen(false)}>Cancel</Button>
              <Button onClick={() => setModalOpen(false)}>Save Changes</Button>
            </>
          }
        >
          <p className="text-compact text-content-secondary">
            This is a modal dialog. Press Escape or click outside to close.
          </p>
        </Modal>

        <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Sheet Panel">
          <div className="p-5">
            <p className="text-compact text-content-secondary">
              A slide-in panel from the right. Great for detail views and forms.
            </p>
          </div>
        </Sheet>

        <ConfirmDialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title="Delete Resource"
          description="This action cannot be undone. All associated data will be permanently removed."
          confirmLabel="Delete"
          onConfirm={() => setConfirmOpen(false)}
          destructive
          confirmText="delete"
        />
      </DemoCard>
    </div>
  )
}

// ── Tabs Gallery ─────────────────────────────────────────────────────────────

function TabsGallery() {
  const [tab, setTab] = useState('general')

  return (
    <div>
      <SectionTitle>Tabs</SectionTitle>
      <DemoCard>
        <Tabs
          tabs={[
            { id: 'general', label: 'General', icon: Settings },
            { id: 'models', label: 'AI & Models', icon: Zap },
            { id: 'connections', label: 'Connections' },
            { id: 'system', label: 'System' },
          ]}
          activeTab={tab}
          onChange={setTab}
        />
        <div className="mt-4 text-compact text-content-secondary">
          Active tab: <span className="font-semibold text-content-primary">{tab}</span>
        </div>
      </DemoCard>
    </div>
  )
}

// ── Accordion Gallery ────────────────────────────────────────────────────────

function AccordionGallery() {
  return (
    <div>
      <SectionTitle>Accordion</SectionTitle>
      <DemoCard>
        <SubSection title="Single mode">
          <Card variant="outlined">
            <Accordion
              items={[
                { id: '1', title: 'What is Nova?', content: 'Nova is a self-directed autonomous AI platform.' },
                { id: '2', title: 'How do I deploy?', content: 'Run docker compose up to start all services.' },
                { id: '3', title: 'Is GPU required?', content: 'No, GPU is optional for local inference.' },
              ]}
              defaultOpen={['1']}
            />
          </Card>
        </SubSection>
        <SubSection title="Multiple mode">
          <Card variant="outlined">
            <Accordion
              items={[
                { id: 'a', title: 'First item', content: 'Content for item A.' },
                { id: 'b', title: 'Second item', content: 'Content for item B.' },
                { id: 'c', title: 'Third item', content: 'Content for item C.' },
              ]}
              multiple
              defaultOpen={['a', 'b']}
            />
          </Card>
        </SubSection>
      </DemoCard>
    </div>
  )
}

// ── EmptyState Gallery ───────────────────────────────────────────────────────

function EmptyStateGallery() {
  return (
    <div>
      <SectionTitle>EmptyState</SectionTitle>
      <DemoCard>
        <EmptyState
          icon={Inbox}
          title="No tasks yet"
          description="Create your first task to get started with Nova's agent pipeline."
          action={{ label: 'Create Task', onClick: () => {} }}
        />
      </DemoCard>
    </div>
  )
}

// ── Skeleton Gallery ─────────────────────────────────────────────────────────

function SkeletonGallery() {
  return (
    <div>
      <SectionTitle>Skeleton</SectionTitle>
      <DemoCard>
        <SubSection title="Text lines">
          <div className="max-w-sm">
            <Skeleton variant="text" lines={3} />
          </div>
        </SubSection>
        <SubSection title="Rect + Circle">
          <div className="flex items-start gap-4">
            <Skeleton variant="circle" width="48px" />
            <div className="flex-1 space-y-2">
              <Skeleton variant="text" width="60%" />
              <Skeleton variant="rect" height="64px" />
            </div>
          </div>
        </SubSection>
      </DemoCard>
    </div>
  )
}

// ── Tooltip & Popover Gallery ────────────────────────────────────────────────

function TooltipPopoverGallery() {
  return (
    <div>
      <SectionTitle>Tooltip &amp; Popover</SectionTitle>
      <DemoCard>
        <SubSection title="Tooltip positions">
          <div className="flex flex-wrap items-center gap-6 py-4">
            <Tooltip content="Tooltip on top" side="top">
              <Button variant="outline" size="sm">Top</Button>
            </Tooltip>
            <Tooltip content="Tooltip on bottom" side="bottom">
              <Button variant="outline" size="sm">Bottom</Button>
            </Tooltip>
            <Tooltip content="Tooltip on left" side="left">
              <Button variant="outline" size="sm">Left</Button>
            </Tooltip>
            <Tooltip content="Tooltip on right" side="right">
              <Button variant="outline" size="sm">Right</Button>
            </Tooltip>
          </div>
        </SubSection>
        <SubSection title="Popover">
          <Popover
            trigger={<Button variant="secondary" size="sm">Click for popover</Button>}
            align="start"
          >
            <div className="w-48 p-2">
              <p className="text-compact text-content-primary font-medium mb-1">Popover content</p>
              <p className="text-caption text-content-secondary">Click outside to close.</p>
            </div>
          </Popover>
        </SubSection>
      </DemoCard>
    </div>
  )
}

// ── Toast Gallery ────────────────────────────────────────────────────────────

function ToastGallery() {
  const { addToast } = useToast()

  return (
    <div>
      <SectionTitle>Toast</SectionTitle>
      <DemoCard>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" size="sm" onClick={() => addToast({ variant: 'success', message: 'Settings saved successfully.' })}>
            Success toast
          </Button>
          <Button variant="secondary" size="sm" onClick={() => addToast({ variant: 'error', message: 'Failed to connect to database.' })}>
            Error toast
          </Button>
          <Button variant="secondary" size="sm" onClick={() => addToast({ variant: 'warning', message: 'Rate limit approaching threshold.' })}>
            Warning toast
          </Button>
          <Button variant="secondary" size="sm" onClick={() => addToast({ variant: 'info', message: 'New model available for download.', action: { label: 'View', onClick: () => {} } })}>
            Info toast (with action)
          </Button>
        </div>
      </DemoCard>
    </div>
  )
}

// ── SearchInput Gallery ──────────────────────────────────────────────────────

function SearchInputGallery() {
  const [search, setSearch] = useState('')

  return (
    <div>
      <SectionTitle>SearchInput</SectionTitle>
      <DemoCard>
        <div className="max-w-sm space-y-4">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search tasks..."
            shortcutHint="/"
          />
          <p className="text-caption text-content-tertiary">
            Current value: {search ? `"${search}"` : '(empty)'}
          </p>
        </div>
      </DemoCard>
    </div>
  )
}

// ── ModelPicker Gallery ──────────────────────────────────────────────────────

function ModelPickerGallery() {
  const [model, setModel] = useState('auto')

  return (
    <div>
      <SectionTitle>ModelPicker</SectionTitle>
      <DemoCard>
        <div className="max-w-sm">
          <ModelPicker
            value={model}
            onChange={setModel}
            showAuto
            models={[
              { id: 'claude-3-opus', provider: 'Anthropic' },
              { id: 'claude-3-sonnet', provider: 'Anthropic' },
              { id: 'gpt-4o', provider: 'OpenAI' },
              { id: 'llama-3.1-70b', provider: 'Ollama' },
            ]}
          />
          <p className="text-caption text-content-tertiary mt-2">
            Selected: {model}
          </p>
        </div>
      </DemoCard>
    </div>
  )
}

// ── Breadcrumb Gallery ───────────────────────────────────────────────────────

function BreadcrumbGallery() {
  return (
    <div>
      <SectionTitle>Breadcrumb</SectionTitle>
      <DemoCard>
        <SubSection title="Standard">
          <Breadcrumb items={[
            { label: 'Home', to: '/' },
            { label: 'Settings', to: '/settings' },
            { label: 'LLM Routing' },
          ]} />
        </SubSection>
        <SubSection title="Short">
          <Breadcrumb items={[
            { label: 'Dashboard', to: '/' },
            { label: 'Tasks' },
          ]} />
        </SubSection>
      </DemoCard>
    </div>
  )
}

// ── Main Gallery ───────────────────────────────────────────────────────────────

export default function ComponentGallery() {
  return (
    <div className="min-h-screen bg-surface-root p-10">
      <h1 className="font-sans text-h1 text-content-primary mb-2">Component Gallery</h1>
      <p className="text-body text-content-secondary mb-12">
        Visual reference for all design system components.
      </p>
      <section className="space-y-12">
        <ButtonGallery />
        <InputGallery />
        <TextareaGallery />
        <SelectGallery />
        <CheckboxGallery />
        <ToggleGallery />
        <RadioGallery />
        <SliderGallery />
        <SearchInputGallery />
        <ModelPickerGallery />
        <BadgeGallery />
        <AvatarGallery />
        <StatusDotGallery />
        <CodeGallery />
        <CopyableIdGallery />
        <MetricGallery />
        <ProgressBarGallery />
        <PipelineStagesGallery />
        <TableGallery />
        <DataListGallery />
        <CardGallery />
        <SectionGallery />
        <TabsGallery />
        <AccordionGallery />
        <ModalSheetGallery />
        <TooltipPopoverGallery />
        <ToastGallery />
        <EmptyStateGallery />
        <SkeletonGallery />
        <BreadcrumbGallery />
      </section>
    </div>
  )
}
