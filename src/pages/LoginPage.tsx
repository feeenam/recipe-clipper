import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { Turnstile } from '../components/Turnstile'

// Optional: where "request an invite" sends people. Hidden when unset.
const INVITE_EMAIL = import.meta.env.VITE_INVITE_EMAIL as string | undefined

export function LoginPage() {
  const navigate = useNavigate()
  const { session, loading, isAnonymous } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [captchaReset, setCaptchaReset] = useState(0)
  const [busy, setBusy] = useState<'password' | 'reset' | 'trial' | null>(null)
  const [resetSent, setResetSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Already signed in with a real account: nothing to do here. A trial session can still sign in.
  if (!loading && session && !isAnonymous) return <Navigate to="/" replace />

  function finishAttempt() {
    // Turnstile tokens are single-use, so every attempt needs a fresh one.
    setCaptchaToken(null)
    setCaptchaReset((n) => n + 1)
    setBusy(null)
  }

  async function handlePasswordSignIn(e: React.FormEvent) {
    e.preventDefault()
    if (!captchaToken) return
    setBusy('password')
    setError(null)
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
      options: { captchaToken },
    })
    if (authError) {
      setError(
        authError.code === 'invalid_credentials' || /invalid login credentials/i.test(authError.message)
          ? 'Wrong email or password.'
          : authError.message
      )
      finishAttempt()
      return
    }
    navigate('/')
  }

  // Also the way to set a first password: invited users don't have one yet. The link in the
  // email signs them in and the app then asks for a new password (see SetPasswordPage).
  async function handleReset() {
    if (!email.trim()) {
      setError('Enter your email first.')
      return
    }
    if (!captchaToken) return
    setBusy('reset')
    setError(null)
    const { error: authError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin,
      captchaToken,
    })
    if (authError) setError(authError.message)
    else setResetSent(true)
    finishAttempt()
  }

  async function handleTrial() {
    if (!captchaToken) return
    setBusy('trial')
    setError(null)
    const { error: authError } = await supabase.auth.signInAnonymously({ options: { captchaToken } })
    if (authError) {
      setError(authError.message)
      finishAttempt()
      return
    }
    navigate('/')
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-16">
      <div className="w-full max-w-xl">
        <h1 className="text-3xl font-semibold text-gray-900 mb-2">Recipe Clipper</h1>
        <p className="text-gray-500 mb-8">Sign in to see your recipes.</p>

        {resetSent ? (
          <p className="text-gray-700">
            If <span className="font-medium">{email}</span> has an account, we've emailed a link to set your password.
            You can close this tab.
          </p>
        ) : (
          <>
            <form onSubmit={handlePasswordSignIn} className="flex flex-col gap-3">
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="border border-gray-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
              <input
                type="password"
                required
                autoComplete="current-password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="border border-gray-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
              <Turnstile onToken={setCaptchaToken} resetKey={captchaReset} />
              <button
                type="submit"
                disabled={!captchaToken || busy !== null}
                className="bg-gray-900 hover:bg-gray-800 disabled:opacity-50 text-white font-medium px-5 py-3 rounded-lg"
              >
                {busy === 'password' ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
            <button
              type="button"
              onClick={handleReset}
              disabled={!captchaToken || busy !== null}
              className="text-gray-500 hover:text-gray-700 disabled:opacity-50 text-sm mt-3 underline"
            >
              {busy === 'reset' ? 'Sending…' : 'Forgot your password, or first time here? Email me a link to set one'}
            </button>
            {error && <p className="text-red-600 text-sm mt-3">{error}</p>}

            <div className="mt-10 pt-6 border-t border-gray-200">
              <p className="text-gray-500 text-sm mb-3">
                No account? Accounts are invite-only, but you can try saving one recipe.
              </p>
              {isAnonymous ? (
                <Link to="/" className="text-gray-900 underline text-sm">
                  Continue your trial
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={handleTrial}
                  disabled={!captchaToken || busy !== null}
                  className="text-sm px-4 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                >
                  {busy === 'trial' ? 'Starting…' : 'Try one recipe'}
                </button>
              )}
              {INVITE_EMAIL && (
                <p className="text-gray-400 text-sm mt-3">
                  Want an account?{' '}
                  <a href={`mailto:${INVITE_EMAIL}?subject=Recipe%20Clipper%20invite`} className="underline">
                    Request an invite
                  </a>
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
