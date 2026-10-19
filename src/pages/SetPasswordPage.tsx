import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

const MIN_PASSWORD_LENGTH = 8

// Shown after someone opens a password-reset (or first-time "set a password") email link.
export function SetPasswordPage() {
  const navigate = useNavigate()
  const { finishRecovery } = useAuth()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (password !== confirm) {
      setError("Those passwords don't match.")
      return
    }
    setSaving(true)
    setError(null)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (updateError) {
      setError(updateError.message)
      setSaving(false)
      return
    }
    finishRecovery()
    navigate('/', { replace: true })
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-16">
      <div className="w-full max-w-xl">
        <h1 className="text-3xl font-semibold text-gray-900 mb-2">Set your password</h1>
        <p className="text-gray-500 mb-8">Choose a password to sign in with next time.</p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="password"
            required
            autoComplete="new-password"
            placeholder="New password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="border border-gray-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
          <input
            type="password"
            required
            autoComplete="new-password"
            placeholder="Confirm new password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="border border-gray-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
          <button
            type="submit"
            disabled={saving}
            className="bg-gray-900 hover:bg-gray-800 disabled:opacity-50 text-white font-medium px-5 py-3 rounded-lg"
          >
            {saving ? 'Saving…' : 'Save password'}
          </button>
        </form>
        {error && <p className="text-red-600 text-sm mt-3">{error}</p>}
      </div>
    </div>
  )
}
