import { useCallback, useEffect, useRef, useState } from 'react'

export type VoiceAssistantStatus = 'off' | 'listening' | 'thinking' | 'speaking'

interface UseVoiceAssistantArgs {
  steps: string[]
  ingredients: string[]
}

interface VoiceAssistantResponse {
  speech: string
  newStep?: number
  finished?: boolean
  shouldStop?: boolean
  noop?: boolean
}

const CANDIDATE_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']

const SPEAKING_THRESHOLD = 0.02
const SILENCE_MS = 1000
const MIN_SPEECH_MS = 300
const MAX_UTTERANCE_MS = 15000

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const type of CANDIDATE_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

function computeRms(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buffer)
  let sumSquares = 0
  for (let i = 0; i < buffer.length; i++) {
    const normalized = (buffer[i] - 128) / 128
    sumSquares += normalized * normalized
  }
  return Math.sqrt(sumSquares / buffer.length)
}

export function shouldStartRecording(rms: number, threshold = SPEAKING_THRESHOLD): boolean {
  return rms > threshold
}

export function shouldStopRecording(
  { now, lastAboveThreshold, utteranceStart }: { now: number; lastAboveThreshold: number; utteranceStart: number },
  { silenceMs = SILENCE_MS, minSpeechMs = MIN_SPEECH_MS, maxUtteranceMs = MAX_UTTERANCE_MS } = {}
): boolean {
  const elapsed = now - utteranceStart
  if (elapsed >= maxUtteranceMs) return true
  const silentFor = now - lastAboveThreshold
  return silentFor >= silenceMs && elapsed >= minSpeechMs
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function speak(text: string, onEnd?: () => void) {
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  if (onEnd) utterance.onend = onEnd
  window.speechSynthesis.speak(utterance)
}

export function useVoiceAssistant({ steps, ingredients }: UseVoiceAssistantArgs) {
  const [isSupported] = useState(
    () =>
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined' &&
      typeof window.speechSynthesis !== 'undefined'
  )
  const [status, setStatus] = useState<VoiceAssistantStatus>('off')
  const [currentStep, setCurrentStep] = useState(0)

  const activeRef = useRef(false)
  const pausedRef = useRef(false)
  const currentStepRef = useRef(0)

  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const rafRef = useRef<number | null>(null)

  const recordingRef = useRef(false)
  const lastAboveThresholdRef = useRef(0)
  const utteranceStartRef = useRef(0)
  const mimeTypeRef = useRef('')

  useEffect(() => {
    currentStepRef.current = currentStep
  }, [currentStep])

  const cleanupAudio = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
    mediaRecorderRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
    analyserRef.current = null
    recordingRef.current = false
  }, [])

  const stop = useCallback(() => {
    activeRef.current = false
    cleanupAudio()
    window.speechSynthesis.cancel()
    setStatus('off')
  }, [cleanupAudio])

  const announceInitialStep = useCallback(() => {
    setStatus('speaking')
    pausedRef.current = true
    if (steps.length === 0) {
      speak('This recipe has no steps.', () => {
        pausedRef.current = false
        if (activeRef.current) setStatus('listening')
      })
      return
    }
    speak(`Step 1. ${steps[0]}`, () => {
      pausedRef.current = false
      if (activeRef.current) setStatus('listening')
    })
  }, [steps])

  const handleUtterance = useCallback(
    async (blob: Blob) => {
      pausedRef.current = true
      setStatus('thinking')

      let result: VoiceAssistantResponse
      try {
        const audio = await blobToBase64(blob)
        const resp = await fetch('/api/voice-assistant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audio,
            mimeType: mimeTypeRef.current,
            steps,
            ingredients,
            currentStep: currentStepRef.current,
          }),
        })
        result = await resp.json()
      } catch (err) {
        console.error('Voice assistant request failed:', err)
        result = { speech: "Sorry, I'm having trouble right now. Please try again." }
      }

      if (!activeRef.current) return

      if (result.noop) {
        pausedRef.current = false
        setStatus('listening')
        return
      }

      setStatus('speaking')
      speak(result.speech, () => {
        if (typeof result.newStep === 'number') {
          setCurrentStep(result.newStep)
          currentStepRef.current = result.newStep
        }
        if (result.shouldStop) {
          stop()
          return
        }
        pausedRef.current = false
        if (activeRef.current) setStatus('listening')
      })
    },
    [ingredients, steps, stop]
  )

  const runVadLoop = useCallback(() => {
    const analyser = analyserRef.current
    const recorder = mediaRecorderRef.current
    if (!analyser || !recorder) return

    const buffer = new Uint8Array(new ArrayBuffer(analyser.fftSize))

    const tick = () => {
      if (!activeRef.current) return

      if (!pausedRef.current) {
        const rms = computeRms(analyser, buffer)
        const now = performance.now()

        if (!recordingRef.current) {
          if (shouldStartRecording(rms)) {
            recordingRef.current = true
            utteranceStartRef.current = now
            lastAboveThresholdRef.current = now
            chunksRef.current = []
            if (recorder.state === 'inactive') recorder.start()
          }
        } else {
          if (shouldStartRecording(rms)) lastAboveThresholdRef.current = now
          if (
            shouldStopRecording({
              now,
              lastAboveThreshold: lastAboveThresholdRef.current,
              utteranceStart: utteranceStartRef.current,
            })
          ) {
            recordingRef.current = false
            if (recorder.state !== 'inactive') recorder.stop()
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const start = useCallback(async () => {
    if (!isSupported) return

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      console.error('Microphone access denied:', err)
      speak('Microphone access is required for the voice assistant.')
      return
    }

    activeRef.current = true
    pausedRef.current = false
    setCurrentStep(0)
    currentStepRef.current = 0

    streamRef.current = stream

    const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const audioContext = new AudioContextCtor()
    const source = audioContext.createMediaStreamSource(stream)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    audioContextRef.current = audioContext
    analyserRef.current = analyser

    const mimeType = pickMimeType()
    mimeTypeRef.current = mimeType
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data)
    }
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current || recorder.mimeType })
      chunksRef.current = []
      if (blob.size > 0 && activeRef.current) {
        handleUtterance(blob)
      }
    }

    mediaRecorderRef.current = recorder

    runVadLoop()
    announceInitialStep()
  }, [announceInitialStep, handleUtterance, isSupported, runVadLoop])

  const toggle = useCallback(() => {
    if (activeRef.current) {
      stop()
    } else {
      start()
    }
  }, [start, stop])

  useEffect(() => {
    return () => {
      activeRef.current = false
      cleanupAudio()
      window.speechSynthesis.cancel()
    }
  }, [cleanupAudio])

  return { isSupported, status, currentStep, toggle }
}
