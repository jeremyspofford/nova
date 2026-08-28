import { useState, useRef, useCallback } from 'react'
import { Send, Mic, Square, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import { Tooltip } from './Tooltip'

interface MorphButtonProps {
  hasText: boolean
  isRecording: boolean
  isTranscribing: boolean
  conversationMode: boolean
  voiceAvailable: boolean
  insecureContext?: boolean
  onSend: () => void
  onToggleRecording: () => void
  onStartConversation: () => void
  onStopConversation: () => void
}

type MorphState = 'mic' | 'send' | 'stop-recording' | 'stop-conversation' | 'transcribing'

function getMorphState(props: MorphButtonProps): MorphState {
  // Priority order per spec
  if (props.isRecording) return 'stop-recording'
  if (props.conversationMode) return 'stop-conversation'
  if (props.isTranscribing) return 'transcribing'
  if (props.hasText) return 'send'
  if (props.voiceAvailable) return 'mic'
  return 'send'
}

const LONG_PRESS_MS = 500

export function MorphButton(props: MorphButtonProps) {
  const { voiceAvailable, insecureContext, onSend, onToggleRecording, onStartConversation, onStopConversation } = props
  const state = getMorphState(props)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [longPressTriggered, setLongPressTriggered] = useState(false)

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Prevent keyboard dismiss on iOS — keeps textarea focused so click fires reliably
    e.preventDefault()
    if (state !== 'mic' || !voiceAvailable) return
    setLongPressTriggered(false)
    longPressTimer.current = setTimeout(() => {
      setLongPressTriggered(true)
      onStartConversation()
    }, LONG_PRESS_MS)
  }, [state, voiceAvailable, onStartConversation])

  const handlePointerUp = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    if (longPressTriggered) {
      setLongPressTriggered(false)
      return
    }
  }, [longPressTriggered])

  const handleClick = useCallback(() => {
    if (longPressTriggered) return // handled by pointerUp
    switch (state) {
      case 'send': onSend(); break
      case 'mic': onStartConversation(); break  // Tap mic = start conversation mode
      case 'stop-recording': onToggleRecording(); break
      case 'stop-conversation': onStopConversation(); break
      case 'transcribing': break // disabled
    }
  }, [state, longPressTriggered, onSend, onToggleRecording, onStartConversation, onStopConversation])

  const isStop = state === 'stop-recording'
  const isConvStop = state === 'stop-conversation'
  const isTranscribing = state === 'transcribing'

  const tooltipContent =
    insecureContext && !props.hasText && !voiceAvailable ? 'Voice requires HTTPS' :
    state === 'mic' && voiceAvailable ? 'Tap to talk, hold for conversation' :
    state === 'send' ? 'Send' :
    state === 'stop-recording' ? 'Stop recording' :
    state === 'stop-conversation' ? 'End conversation' :
    ''

  const button = (
    <button
      type="button"
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      aria-disabled={isTranscribing || undefined}
      aria-label={tooltipContent || 'Chat input action'}
      className={clsx(
        'w-11 h-11 rounded-full flex items-center justify-center transition-all duration-150 shrink-0',
        isStop
          ? 'bg-danger text-white hover:bg-red-500'
          : isConvStop
            ? 'bg-amber-500 text-neutral-950 hover:bg-amber-400'
            : 'bg-teal-500 hover:bg-teal-600 text-white shadow-[0_0_12px_rgba(25,168,158,0.3)] hover:shadow-[0_0_20px_rgba(25,168,158,0.4)]',
        isTranscribing && 'opacity-40 cursor-wait',
      )}
    >
      {state === 'transcribing' && <Loader2 size={16} className="animate-spin" />}
      {state === 'send' && <Send size={16} />}
      {state === 'mic' && <Mic size={16} />}
      {state === 'stop-recording' && <Square size={14} fill="currentColor" />}
      {state === 'stop-conversation' && <Square size={14} fill="currentColor" />}
    </button>
  )

  return (
    <div className="relative shrink-0">
      {tooltipContent ? <Tooltip content={tooltipContent}>{button}</Tooltip> : button}
    </div>
  )
}
