// dashboard/src/components/VoiceModeOverlay.tsx
import { Mic, MicOff, PhoneOff } from 'lucide-react'
import { VoiceOrb, type OrbState } from './VoiceOrb'

interface VoiceModeOverlayProps {
  orbState:       OrbState
  caption:        string
  muted:          boolean
  voiceAvailable: boolean
  onToggleMute:   () => void
  onEnd:          () => void
}

export function VoiceModeOverlay({
  orbState,
  caption,
  muted,
  voiceAvailable,
  onToggleMute,
  onEnd,
}: VoiceModeOverlayProps) {
  return (
    {/* Intentionally opaque bg-[#030712] — matches VoiceOrb canvas fill exactly.
        Cannot use glass-overlay here: the orb's starfield bleeds to the edge and
        requires a clean dark backdrop with no tint or blur. See Brain HUD pattern. */}
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#030712]">
      {/* Orb */}
      <div className="flex-1 flex items-center justify-center">
        <VoiceOrb state={orbState} size={240} />
      </div>

      {/* Caption */}
      <p className="text-xs text-stone-500 text-center px-8 min-h-5 mb-6 max-w-xs truncate" title={caption}>
        {caption}
      </p>

      {/* Controls */}
      <div className="flex gap-5 mb-10">
        {voiceAvailable && (
          <button
            type="button"
            onClick={onToggleMute}
            className="w-12 h-12 rounded-full flex items-center justify-center bg-stone-800 border border-stone-700 text-stone-400 hover:text-stone-200 hover:border-stone-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400"
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
        )}
        <button
          type="button"
          onClick={onEnd}
          className="w-12 h-12 rounded-full flex items-center justify-center bg-red-900/60 border border-red-800/50 text-red-300 hover:bg-red-800/70 hover:text-red-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400"
          aria-label="End voice mode"
        >
          <PhoneOff size={18} />
        </button>
      </div>
    </div>
  )
}
