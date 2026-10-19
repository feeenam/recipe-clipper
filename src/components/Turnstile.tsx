import { useEffect, useRef } from 'react'

// Supabase has CAPTCHA protection on, so every sign-in call (magic link and anonymous trial)
// needs a Turnstile token. Tokens are single-use: bump `resetKey` after each attempt.
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

interface TurnstileApi {
  render: (
    el: HTMLElement,
    options: {
      sitekey: string
      callback: (token: string) => void
      'expired-callback': () => void
      'error-callback': () => void
    }
  ) => string
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = SCRIPT_SRC
      script.async = true
      script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile unavailable')))
      script.onerror = () => {
        scriptPromise = null
        reject(new Error('Could not load the bot check'))
      }
      document.head.appendChild(script)
    })
  }
  return scriptPromise
}

export function Turnstile({ onToken, resetKey }: { onToken: (token: string | null) => void; resetKey: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  const onTokenRef = useRef(onToken)
  onTokenRef.current = onToken

  useEffect(() => {
    if (!SITE_KEY || !containerRef.current) return
    let cancelled = false
    const container = containerRef.current
    loadTurnstile()
      .then((api) => {
        if (cancelled) return
        widgetIdRef.current = api.render(container, {
          sitekey: SITE_KEY,
          callback: (token) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(null),
          'error-callback': () => onTokenRef.current(null),
        })
      })
      .catch(() => onTokenRef.current(null))
    return () => {
      cancelled = true
      if (widgetIdRef.current && window.turnstile) window.turnstile.remove(widgetIdRef.current)
      widgetIdRef.current = null
    }
  }, [])

  useEffect(() => {
    if (resetKey > 0 && widgetIdRef.current && window.turnstile) {
      onTokenRef.current(null)
      window.turnstile.reset(widgetIdRef.current)
    }
  }, [resetKey])

  if (!SITE_KEY) {
    return <p className="text-sm text-red-600">VITE_TURNSTILE_SITE_KEY is not set.</p>
  }
  return <div ref={containerRef} />
}
