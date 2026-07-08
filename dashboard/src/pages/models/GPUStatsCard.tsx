import { useQuery } from '@tanstack/react-query'
import { Cpu, Activity, Layers, Thermometer } from 'lucide-react'
import { getGPUStats } from '../../api-recovery'
import { Card, ProgressBar } from '../../components/ui'

export function GPUStatsCard() {
  const { data: gpuStats } = useQuery({
    queryKey: ['gpu-stats'],
    queryFn: getGPUStats,
    refetchInterval: 10_000,
  })

  if (!gpuStats) return null

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Cpu size={16} className="text-accent" />
        <span className="text-compact font-semibold text-content-primary">GPU</span>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <span className="text-caption text-content-tertiary flex items-center gap-1">
            <Activity size={10} /> Utilization
          </span>
          <p className="text-display font-mono text-content-primary mt-1">{gpuStats.gpu_utilization_pct}%</p>
        </div>
        <div>
          <span className="text-caption text-content-tertiary flex items-center gap-1">
            <Layers size={10} /> VRAM
          </span>
          <p className="text-display font-mono text-content-primary mt-1">
            {gpuStats.vram_used_gb}/{gpuStats.vram_total_gb} GB
          </p>
          <ProgressBar
            value={(gpuStats.vram_used_gb / gpuStats.vram_total_gb) * 100}
            size="sm"
            className="mt-1"
          />
        </div>
        <div>
          <span className="text-caption text-content-tertiary flex items-center gap-1">
            <Thermometer size={10} /> Temp
          </span>
          <p className="text-display font-mono text-content-primary mt-1">{gpuStats.temperature_c}&deg;C</p>
        </div>
      </div>
    </Card>
  )
}
