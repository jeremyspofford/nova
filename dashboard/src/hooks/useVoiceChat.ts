import { useState, useRef, useCallback, useEffect } from 'react'
import { getAuthHeaders } from '../api'

interface UseVoiceChatOptions {
  onTranscript?: (text: string) => void
  onError?: (error: string) => void
  maxDurationMs?: number
  minDurationMs?: number
  /** Silence duration before auto-stop in conversation mode (ms) */
  silenceTimeoutMs?: number
  /** Audio level threshold to trigger barge-in (0–1) */
  bargeInThreshold?: number
  /** Audio level below which counts as silence (0–1) */
  silenceThreshold?: number
  /** How long voice must be sustained to trigger barge-in (ms) */
  bargeInDurationMs?: number
}

interface SentenceAudio {
  seq: number
  audio: HTMLAudioElement | null
  blobUrl: string | null
  status: 'pending' | 'loading' | 'ready' | 'playing' | 'done'
}

export type ConversationState = 'idle' | 'listening' | 'processing' | 'speaking'

export function useVoiceChat({
  onTranscript,
  onError,
  maxDurationMs = 60_000,
  minDurationMs = 500,
  silenceTimeoutMs = 2000,
  bargeInThreshold = 0.15,
  silenceThreshold = 0.05,
  bargeInDurationMs = 300,
}: UseVoiceChatOptions = {}) {
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [voiceAvailable, setVoiceAvailable] = useState(false)
  const [muted, setMuted] = useState(() => localStorage.getItem('nova_voice_muted') === 'true')
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null)

  // Conversation mode
  const [conversationMode, setConversationMode] = useState(false)
  const [silenceCountdown, setSilenceCountdown] = useState(0)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const mimeTypeRef = useRef('audio/webm;codecs=opus')
  const recordStartRef = useRef(0)
  const durationIntervalRef = useRef<ReturnType<typeof setInterval>>()
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // Audio playback queue
  const audioQueueRef = useRef<SentenceAudio[]>([])
  const currentSeqRef = useRef(0)
  const nextSeqRef = useRef(0)
  const sentenceBufferRef = useRef('')
  const inCodeBlockRef = useRef(false)

  // Warm mic refs (conversation mode)
  const warmStreamRef = useRef<MediaStream | null>(null)
  const warmCtxRef = useRef<AudioContext | null>(null)
  const warmAnalyserRef = useRef<AnalyserNode | null>(null)
  const levelPollRef = useRef<ReturnType<typeof setInterval>>()
  const currentLevelRef = useRef(0)
  const bargeInStartRef = useRef(0)
  const silenceStartRef = useRef(0)
  const wasSpeakingRef = useRef(false)
  const silentTurnsRef = useRef(0)

  // Refs for latest values (avoids stale closures in polling loop)
  const isRecordingRef = useRef(false)
  const isSpeakingRef = useRef(false)
  const isTranscribingRef = useRef(false)
  const conversationModeRef = useRef(false)
  useEffect(() => { isRecordingRef.current = isRecording }, [isRecording])
  useEffect(() => { isSpeakingRef.current = isSpeaking }, [isSpeaking])
  useEffect(() => { isTranscribingRef.current = isTranscribing }, [isTranscribing])
  useEffect(() => { conversationModeRef.current = conversationMode }, [conversationMode])

  // Check voice service availability (requires HTTPS or localhost for mediaDevices)
  useEffect(() => {
    const hasMicAccess = !!(navigator.mediaDevices?.getUserMedia)
    if (!hasMicAccess) {
      setVoiceAvailable(false)
      return
    }
    const check = async () => {
      try {
        const resp = await fetch('/voice-api/health/ready')
        if (resp.ok) {
          const data = await resp.json()
          const checks = data.checks ?? data
          setVoiceAvailable(!!(checks.stt_available && checks.tts_available))
        }
      } catch {
        setVoiceAvailable(false)
      }
    }
    check()
    const interval = setInterval(check, 30_000)
    return () => clearInterval(interval)
  }, [])

  // Persist mute state
  useEffect(() => {
    localStorage.setItem('nova_voice_muted', String(muted))
  }, [muted])

  // Detect supported MIME type
  useEffect(() => {
    const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus']
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        mimeTypeRef.current = type
        break
      }
    }
  }, [])

  const stopAllPlayback = useCallback(() => {
    audioQueueRef.current.forEach(item => {
      if (item.audio) {
        item.audio.pause()
        item.audio.currentTime = 0
      }
      if (item.blobUrl) URL.revokeObjectURL(item.blobUrl)
    })
    audioQueueRef.current = []
    currentSeqRef.current = 0
    nextSeqRef.current = 0
    sentenceBufferRef.current = ''
    inCodeBlockRef.current = false
    setIsSpeaking(false)
  }, [])

  // Immediately stop playback when muted
  useEffect(() => {
    if (muted) stopAllPlayback()
  }, [muted, stopAllPlayback])

  // ── Recording (shared between manual and conversation mode) ──

  /** Start a MediaRecorder on a given stream. If keepStream, don't stop tracks on recorder.onstop. */
  const startRecordingOnStream = useCallback((stream: MediaStream, keepStream: boolean) => {
    const recorder = new MediaRecorder(stream, { mimeType: mimeTypeRef.current })
    chunksRef.current = []

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }

    recorder.onstop = async () => {
      if (!keepStream) {
        stream.getTracks().forEach(t => t.stop())
        setMediaStream(null)
      }
      clearInterval(durationIntervalRef.current)
      clearTimeout(maxDurationTimerRef.current)

      const elapsed = Date.now() - recordStartRef.current
      const effectiveMin = conversationModeRef.current ? 300 : minDurationMs
      if (elapsed < effectiveMin) {
        setIsRecording(false)
        // In conversation mode, a too-short recording counts as a silent turn
        if (conversationModeRef.current) {
          silentTurnsRef.current++
          if (silentTurnsRef.current >= 3) {
            setConversationMode(false)
          }
        }
        return
      }

      const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current })
      setIsRecording(false)
      setIsTranscribing(true)

      try {
        const resp = await fetch('/voice-api/stt/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', ...getAuthHeaders() },
          body: blob,
        })

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ detail: 'Transcription failed' }))
          throw new Error(err.detail || `HTTP ${resp.status}`)
        }

        // STT returns SSE: `data: {"text": "...", "is_final": true}\n\n`
        const body = await resp.text()
        const result = body.split('\n').reduce<{ text?: string }>((acc, line) => {
          if (!line.startsWith('data: ')) return acc
          try { return JSON.parse(line.slice(6)) } catch { return acc }
        }, {})
        if (result.text) {
          silentTurnsRef.current = 0  // Reset silent turn counter on successful transcript
          onTranscript?.(result.text)
        } else {
          if (conversationModeRef.current) {
            silentTurnsRef.current++
            if (silentTurnsRef.current >= 3) setConversationMode(false)
          }
          onError?.("Couldn't understand that — try again")
        }
      } catch (err: any) {
        if (conversationModeRef.current) {
          silentTurnsRef.current++
          if (silentTurnsRef.current >= 3) setConversationMode(false)
        }
        onError?.(err.message || 'Transcription failed — try again or type your message')
      } finally {
        setIsTranscribing(false)
      }
    }

    recorder.start()
    recordStartRef.current = Date.now()
    setIsRecording(true)
    setRecordingDuration(0)
    setSilenceCountdown(0)
    silenceStartRef.current = 0
    mediaRecorderRef.current = recorder

    // Duration counter
    durationIntervalRef.current = setInterval(() => {
      setRecordingDuration(Date.now() - recordStartRef.current)
    }, 100)

    // Auto-stop at max duration
    maxDurationTimerRef.current = setTimeout(() => {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
    }, maxDurationMs)
  }, [minDurationMs, maxDurationMs, onTranscript, onError])

  /** Manual recording: get new mic stream, record, stop stream when done */
  const startRecording = useCallback(async () => {
    stopAllPlayback()
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        onError?.('Microphone requires HTTPS. Connect via localhost or enable HTTPS.')
        return
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      setMediaStream(stream)
      startRecordingOnStream(stream, false)
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        onError?.('Microphone access denied. Enable in browser settings.')
      } else {
        onError?.(err.message || 'Could not access microphone')
      }
    }
  }, [stopAllPlayback, startRecordingOnStream, onError])

  /** Start recording on the warm mic stream (conversation mode) */
  const startConversationRecording = useCallback(() => {
    if (!warmStreamRef.current || isRecordingRef.current || isTranscribingRef.current) return
    startRecordingOnStream(warmStreamRef.current, true)
  }, [startRecordingOnStream])

  const stopRecording = useCallback(() => {
    const elapsed = Date.now() - recordStartRef.current
    const effectiveMin = conversationModeRef.current ? 300 : minDurationMs
    if (elapsed < effectiveMin) return

    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
  }, [minDurationMs])

  const toggleRecording = useCallback(() => {
    if (isRecording) stopRecording()
    else startRecording()
  }, [isRecording, startRecording, stopRecording])

  // ── Conversation Mode: Warm Mic Lifecycle ──────────────────────

  useEffect(() => {
    if (!conversationMode) {
      // Teardown warm mic
      if (warmStreamRef.current) {
        // Stop recording if active
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop()
        }
        warmStreamRef.current.getTracks().forEach(t => t.stop())
        warmStreamRef.current = null
        setMediaStream(null)
      }
      if (warmCtxRef.current) {
        warmCtxRef.current.close()
        warmCtxRef.current = null
        warmAnalyserRef.current = null
      }
      clearInterval(levelPollRef.current)
      currentLevelRef.current = 0
      bargeInStartRef.current = 0
      silenceStartRef.current = 0
      silentTurnsRef.current = 0
      setSilenceCountdown(0)
      return
    }

    // Setup warm mic
    if (!navigator.mediaDevices?.getUserMedia) {
      onError?.('Microphone requires HTTPS')
      setConversationMode(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }

        warmStreamRef.current = stream
        setMediaStream(stream)

        // AudioContext + AnalyserNode for level detection
        const ctx = new AudioContext()
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.4
        source.connect(analyser)
        warmCtxRef.current = ctx
        warmAnalyserRef.current = analyser

        // Start audio level polling (50ms = 20fps, works in background tabs)
        const buf = new Uint8Array(analyser.frequencyBinCount)
        levelPollRef.current = setInterval(() => {
          analyser.getByteFrequencyData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
          const rms = Math.sqrt(sum / buf.length) / 255
          currentLevelRef.current = Math.min(1, rms * 2.5)

          const now = Date.now()
          const level = currentLevelRef.current
          const speaking = isSpeakingRef.current
          const recording = isRecordingRef.current
          const convMode = conversationModeRef.current

          if (!convMode) return

          // ── Barge-in detection (while Nova is speaking) ──
          if (speaking && !recording) {
            if (level > bargeInThreshold) {
              if (bargeInStartRef.current === 0) bargeInStartRef.current = now
              else if (now - bargeInStartRef.current > bargeInDurationMs) {
                // Barge-in triggered!
                bargeInStartRef.current = 0
                stopAllPlayback()
                // Short delay to avoid catching tail of TTS audio
                setTimeout(() => {
                  if (warmStreamRef.current && conversationModeRef.current) {
                    startRecordingOnStream(warmStreamRef.current, true)
                  }
                }, 50)
              }
            } else {
              bargeInStartRef.current = 0
            }
          } else {
            bargeInStartRef.current = 0
          }

          // ── Silence detection (while recording in conversation mode) ──
          if (recording && convMode) {
            // Don't check silence during first 800ms (let user get started)
            const elapsed = now - recordStartRef.current
            if (elapsed < 800) {
              silenceStartRef.current = 0
              setSilenceCountdown(0)
              return
            }

            if (level < silenceThreshold) {
              if (silenceStartRef.current === 0) silenceStartRef.current = now
              const silenceElapsed = now - silenceStartRef.current
              const remaining = Math.max(0, silenceTimeoutMs - silenceElapsed)
              setSilenceCountdown(remaining)

              if (silenceElapsed >= silenceTimeoutMs) {
                // Silence timeout — auto-stop recording
                silenceStartRef.current = 0
                setSilenceCountdown(0)
                if (mediaRecorderRef.current?.state === 'recording') {
                  mediaRecorderRef.current.stop()
                }
              }
            } else {
              silenceStartRef.current = 0
              setSilenceCountdown(0)
            }
          }
        }, 50)

        // Start first recording turn
        if (!cancelled) {
          startRecordingOnStream(stream, true)
        }
      } catch (err: any) {
        if (!cancelled) {
          setConversationMode(false)
          if (err.name === 'NotAllowedError') {
            onError?.('Microphone access denied. Enable in browser settings.')
          } else {
            onError?.(err.message || 'Could not access microphone')
          }
        }
      }
    })()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationMode])

  // ── Conversation Mode: Auto-listen after TTS finishes ──────────

  useEffect(() => {
    if (isSpeaking) {
      wasSpeakingRef.current = true
      return
    }

    // TTS just finished — auto-listen if in conversation mode
    if (wasSpeakingRef.current && conversationMode && !isRecording && !isTranscribing) {
      wasSpeakingRef.current = false
      // Short delay so the analyser doesn't pick up tail end of TTS audio
      const timer = setTimeout(() => {
        if (conversationModeRef.current && warmStreamRef.current && !isRecordingRef.current) {
          startConversationRecording()
        }
      }, 400)
      return () => clearTimeout(timer)
    }
  }, [isSpeaking, conversationMode, isRecording, isTranscribing, startConversationRecording])

  // ── Conversation Mode: Escape key to exit ──────────────────────

  useEffect(() => {
    if (!conversationMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConversationMode(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [conversationMode])

  // ── Conversation Mode: Exit also stops recording ───────────────

  useEffect(() => {
    if (!conversationMode && isRecording && mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
  }, [conversationMode, isRecording])

  // ── TTS Playback ──────────────────────────────────────────────

  const playNextInQueue = useCallback(() => {
    const next = audioQueueRef.current.find(
      item => item.seq === currentSeqRef.current && item.status === 'ready'
    )
    if (!next || !next.audio) return

    next.status = 'playing'
    setIsSpeaking(true)

    next.audio.onended = () => {
      next.status = 'done'
      if (next.blobUrl) URL.revokeObjectURL(next.blobUrl)
      currentSeqRef.current++

      // Check if more to play
      const hasMore = audioQueueRef.current.some(
        item => item.seq >= currentSeqRef.current && item.status !== 'done'
      )
      if (!hasMore) {
        setIsSpeaking(false)
        audioQueueRef.current = []
        currentSeqRef.current = 0
        nextSeqRef.current = 0
      } else {
        playNextInQueue()
      }
    }

    if (!muted) {
      next.audio.play().catch(() => {
        // Autoplay blocked — skip this sentence
        next.status = 'done'
        currentSeqRef.current++
        playNextInQueue()
      })
    } else {
      // Muted — skip immediately
      next.status = 'done'
      if (next.blobUrl) URL.revokeObjectURL(next.blobUrl)
      currentSeqRef.current++
      playNextInQueue()
    }
  }, [muted])

  const synthesizeSentence = useCallback(async (text: string, seq: number) => {
    const entry: SentenceAudio = { seq, audio: null, blobUrl: null, status: 'loading' }
    audioQueueRef.current.push(entry)

    try {
      const resp = await fetch('/voice-api/tts/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ text, voice: 'nova', model: 'tts-1' }),
      })
      if (!resp.ok) throw new Error(`TTS failed: ${resp.status}`)

      const blob = await resp.blob()
      const blobUrl = URL.createObjectURL(blob)
      const audio = new Audio(blobUrl)

      entry.audio = audio
      entry.blobUrl = blobUrl
      entry.status = 'ready'

      // Try to play if this is the current sequence
      if (entry.seq === currentSeqRef.current) {
        playNextInQueue()
      }
    } catch {
      // TTS failed for this sentence — mark done, skip it
      entry.status = 'done'
    }
  }, [playNextInQueue])

  // ── Text-to-speakable preprocessor ────────────────────────────

  const toSpeakable = useCallback((text: string): string => {
    let result = text
    // Remove fenced code blocks entirely
    result = result.replace(/```[\s\S]*?```/g, ' Here\'s some code. ')
    // Remove inline code backticks (keep content)
    result = result.replace(/`([^`]+)`/g, '$1')
    // Replace URLs with domain
    result = result.replace(/https?:\/\/([^\s/]+)[^\s]*/g, 'link to $1')
    // Remove markdown tables
    result = result.replace(/\|[^\n]+\|(\n\|[-:| ]+\|)?(\n\|[^\n]+\|)*/g, '')
    // Remove heading markers
    result = result.replace(/^#{1,6}\s+/gm, '')
    // Remove bold/italic markers
    result = result.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
    result = result.replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
    // Remove list markers
    result = result.replace(/^[\s]*[-*]\s+/gm, '')
    result = result.replace(/^[\s]*\d+\.\s+/gm, '')
    // Remove horizontal rules
    result = result.replace(/^---+$/gm, '')
    // Clean up multiple spaces/newlines
    result = result.replace(/\n{2,}/g, '\n').replace(/\s{2,}/g, ' ').trim()
    return result
  }, [])

  // ── Sentence detection + buffer ───────────────────────────────

  const feedText = useCallback((delta: string) => {
    if (muted) return // Don't buffer if muted

    sentenceBufferRef.current += delta

    // Track code blocks
    const fences = (sentenceBufferRef.current.match(/```/g) || []).length
    inCodeBlockRef.current = fences % 2 !== 0
    if (inCodeBlockRef.current) return // Don't split inside code blocks

    // Check for sentence boundaries
    const buf = sentenceBufferRef.current
    const delimiters = /[.!?]\s|[\n]/
    const match = buf.match(delimiters)

    if (match && match.index !== undefined) {
      const boundary = match.index + match[0].length
      const sentence = buf.slice(0, boundary).trim()
      sentenceBufferRef.current = buf.slice(boundary)

      if (sentence) {
        const speakable = toSpeakable(sentence)
        if (speakable.trim()) {
          synthesizeSentence(speakable, nextSeqRef.current++)
        }
      }
    }

    // Max-length fallback
    if (buf.length > 200 && !inCodeBlockRef.current) {
      const sentence = buf.trim()
      sentenceBufferRef.current = ''
      if (sentence) {
        const speakable = toSpeakable(sentence)
        if (speakable.trim()) {
          synthesizeSentence(speakable, nextSeqRef.current++)
        }
      }
    }
  }, [muted, toSpeakable, synthesizeSentence])

  const flushBuffer = useCallback(() => {
    const remaining = sentenceBufferRef.current.trim()
    sentenceBufferRef.current = ''
    inCodeBlockRef.current = false
    if (remaining && !muted) {
      const speakable = toSpeakable(remaining)
      if (speakable.trim()) {
        synthesizeSentence(speakable, nextSeqRef.current++)
      }
    }
  }, [muted, toSpeakable, synthesizeSentence])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAllPlayback()
      clearInterval(durationIntervalRef.current)
      clearTimeout(maxDurationTimerRef.current)
      clearInterval(levelPollRef.current)
      if (warmStreamRef.current) {
        warmStreamRef.current.getTracks().forEach(t => t.stop())
      }
      if (warmCtxRef.current) {
        warmCtxRef.current.close()
      }
    }
  }, [stopAllPlayback])

  // Derive conversation state for UI
  const conversationState: ConversationState = !conversationMode
    ? 'idle'
    : isSpeaking
      ? 'speaking'
      : isRecording
        ? 'listening'
        : (isTranscribing ? 'processing' : 'idle')

  return {
    // Recording
    isRecording,
    isTranscribing,
    recordingDuration,
    toggleRecording,
    startRecording,
    stopRecording,
    // Playback
    isSpeaking,
    muted,
    setMuted,
    feedText,
    flushBuffer,
    stopAllPlayback,
    // State
    voiceAvailable,
    mediaStream,
    // Conversation mode
    conversationMode,
    setConversationMode,
    conversationState,
    silenceCountdown,
    /** Current audio level 0–1 from warm mic (for UI visualization) */
    warmMicLevel: currentLevelRef.current,
  }
}
