import { useCallback, useEffect, useRef, useState } from 'react'

type SpeechRecognitionCtor = new () => SpeechRecognition

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  return (window.SpeechRecognition || window.webkitSpeechRecognition || null) as SpeechRecognitionCtor | null
}

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
}

function speak(text: string, onEnd?: () => void) {
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  if (onEnd) utterance.onend = onEnd
  window.speechSynthesis.speak(utterance)
}

export function useVoiceAssistant({ steps, ingredients }: UseVoiceAssistantArgs) {
  const [isSupported] = useState(() => getSpeechRecognitionCtor() !== null)
  const [status, setStatus] = useState<VoiceAssistantStatus>('off')
  const [currentStep, setCurrentStep] = useState(0)

  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const activeRef = useRef(false)
  const currentStepRef = useRef(0)
  const fatalErrorRef = useRef(false)

  useEffect(() => {
    currentStepRef.current = currentStep
  }, [currentStep])

  const stop = useCallback(() => {
    activeRef.current = false
    recognitionRef.current?.stop()
    window.speechSynthesis.cancel()
    setStatus('off')
  }, [])

  const announceInitialStep = useCallback(() => {
    setStatus('speaking')
    if (steps.length === 0) {
      speak('This recipe has no steps.', () => {
        if (activeRef.current) setStatus('listening')
      })
      return
    }
    speak(`Step 1. ${steps[0]}`, () => {
      if (activeRef.current) setStatus('listening')
    })
  }, [steps])

  const handleTranscript = useCallback(
    async (transcript: string) => {
      setStatus('thinking')

      let result: VoiceAssistantResponse
      try {
        const resp = await fetch('/api/voice-assistant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transcript,
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
        if (activeRef.current) setStatus('listening')
      })
    },
    [ingredients, steps, stop]
  )

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) return

    activeRef.current = true
    fatalErrorRef.current = false
    setCurrentStep(0)
    currentStepRef.current = 0

    const recognition = new Ctor()
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = 'en-US'

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const last = event.results[event.results.length - 1]
      if (last.isFinal) {
        handleTranscript(last[0].transcript)
      }
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return
      console.error('Speech recognition error:', event.error)
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'audio-capture') {
        fatalErrorRef.current = true
        stop()
      }
    }

    recognition.onend = () => {
      if (activeRef.current && !fatalErrorRef.current) {
        try {
          recognition.start()
        } catch {
          // already started; ignore
        }
      }
    }

    recognitionRef.current = recognition
    recognition.start()

    announceInitialStep()
  }, [announceInitialStep, handleTranscript, stop])

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
      recognitionRef.current?.stop()
      window.speechSynthesis.cancel()
    }
  }, [])

  return { isSupported, status, currentStep, toggle }
}
