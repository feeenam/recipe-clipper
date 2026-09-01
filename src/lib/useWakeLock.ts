import { useCallback, useEffect, useRef, useState } from 'react'

export function useWakeLock() {
  const [isActive, setIsActive] = useState(false)
  const [isSupported] = useState(() => typeof navigator !== 'undefined' && 'wakeLock' in navigator)
  const sentinelRef = useRef<WakeLockSentinel | null>(null)

  const release = useCallback(async () => {
    await sentinelRef.current?.release()
    sentinelRef.current = null
    setIsActive(false)
  }, [])

  const request = useCallback(async () => {
    try {
      const sentinel = await navigator.wakeLock.request('screen')
      sentinelRef.current = sentinel
      setIsActive(true)
      sentinel.addEventListener('release', () => {
        sentinelRef.current = null
        setIsActive(false)
      })
    } catch (err) {
      console.error('Wake Lock request failed:', err)
    }
  }, [])

  const toggle = useCallback(() => {
    if (sentinelRef.current) {
      release()
    } else {
      request()
    }
  }, [release, request])

  // iOS releases the lock when the tab is backgrounded; re-acquire on return
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (sentinelRef.current === null && document.visibilityState === 'visible' && isActive) {
        request()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [isActive, request])

  useEffect(() => () => { sentinelRef.current?.release() }, [])

  return { isActive, isSupported, toggle }
}
