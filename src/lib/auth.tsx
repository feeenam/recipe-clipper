import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

interface AuthState {
  session: Session | null
  /** True until the stored session (if any) has been read, so pages don't flash the login wall. */
  loading: boolean
  /** True for the throwaway users created by "Try one recipe". */
  isAnonymous: boolean
  /** True after the user opened a password-reset link: they must pick a new password. */
  recovering: boolean
  finishRecovery: () => void
}

const AuthContext = createContext<AuthState>({
  session: null,
  loading: true,
  isAnonymous: false,
  recovering: false,
  finishRecovery: () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [recovering, setRecovering] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, next) => {
      // A reset link signs the user in, but they still have to choose a new password.
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
      setSession(next)
      setLoading(false)
    })
    return () => subscription.unsubscribe()
  }, [])

  const value: AuthState = {
    session,
    loading,
    isAnonymous: session?.user.is_anonymous === true,
    recovering,
    finishRecovery: () => setRecovering(false),
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
