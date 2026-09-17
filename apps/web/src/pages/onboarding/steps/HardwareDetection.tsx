import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Cpu, HardDrive, Loader2, Server } from 'lucide-react'
import { Button } from '../../../components/ui'
import { getHardware, type HardwareInfo } from '../../../lib/api'

function gb(mb: number | undefined): string | null {
  return mb === undefined ? null : `${Math.round((mb / 1024) * 10) / 10} GB`
}

function Row({
  icon: Icon,
  accent,
  title,
  detail,
}: {
  icon: typeof Cpu
  accent?: boolean
  title: string
  detail?: string | null
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border-subtle bg-surface-elevated p-3">
      <Icon className={`w-5 h-5 shrink-0 ${accent ? 'text-accent' : 'text-content-tertiary'}`} />
      <div className="min-w-0">
        <p className="text-compact font-medium text-content-primary truncate">{title}</p>
        {detail && <p className="text-caption text-content-tertiary">{detail}</p>}
      </div>
    </div>
  )
}

export function HardwareDetection({ onNext }: { onNext: () => void }) {
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    setHardware(null)
    getHardware()
      .then(setHardware)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(load, [load])

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
        <AlertTriangle className="w-10 h-10 text-warning mb-4" />
        <p className="text-compact text-content-secondary mb-4">
          Could not read this machine&apos;s hardware: {error}
        </p>
        <Button variant="outline" onClick={load}>
          Try again
        </Button>
      </div>
    )
  }

  if (!hardware) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <Loader2 className="w-8 h-8 text-accent animate-spin mb-4" />
        <p className="text-compact text-content-secondary">Reading hardware…</p>
      </div>
    )
  }

  const gpus = hardware.gpus ?? []

  return (
    <div className="flex flex-col items-center py-12 px-6">
      <h2 className="text-h3 text-content-primary mb-2">What this machine has</h2>
      <p className="text-compact text-content-secondary mb-6 text-center max-w-md">
        Detected at install time. It decides which model sizes are worth suggesting.
      </p>

      {/* An absent hardware.json is a fact about this host, not an error —
          state it and let setup continue. */}
      {hardware.note && (
        <div className="w-full max-w-sm rounded-lg bg-warning-dim border border-warning/20 p-3 mb-6">
          <p className="text-compact text-warning font-medium">
            {hardware.note}
          </p>
          <p className="text-caption text-content-secondary mt-1">
            Setup continues — model suggestions will assume no GPU.
          </p>
        </div>
      )}

      {!hardware.note && (
        <div
          className={`w-full max-w-sm rounded-lg p-3 mb-6 border ${
            gpus.length
              ? 'bg-success-dim border-success/20'
              : 'bg-warning-dim border-warning/20'
          }`}
        >
          <p
            className={`text-compact font-medium ${
              gpus.length
                ? 'text-success'
                : 'text-warning'
            }`}
          >
            {gpus.length
              ? 'GPU detected — local inference is worth doing here'
              : 'No GPU detected — a small local model or a remote endpoint will serve better'}
          </p>
        </div>
      )}

      <div className="w-full max-w-sm space-y-3">
        {gpus.map((gpu, i) => (
          <Row
            key={i}
            icon={Server}
            accent
            title={gpu.name ?? 'GPU'}
            detail={gb(gpu.vram_mb) ? `${gb(gpu.vram_mb)} VRAM` : 'VRAM not reported'}
          />
        ))}
        <Row
          icon={Cpu}
          title={gb(hardware.ram_mb) ? `${gb(hardware.ram_mb)} RAM` : 'RAM not reported'}
          detail={
            hardware.docker_gpu_runtime === false && gpus.length
              ? 'GPU present but the container GPU runtime is not installed'
              : null
          }
        />
        <Row
          icon={HardDrive}
          title={
            hardware.disk_free_gb === undefined
              ? 'Free disk not reported'
              : `${hardware.disk_free_gb} GB free disk`
          }
        />
      </div>

      <Button className="mt-8" onClick={onNext}>
        Continue
      </Button>
    </div>
  )
}
