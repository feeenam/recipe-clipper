import { useState } from 'react'

interface ProviderStatus {
  name: string
  configured: boolean
  ok: boolean
  latencyMs: number | null
  error: string | null
}

interface StatusResponse {
  primary: ProviderStatus
  backup: ProviderStatus
}

function ProviderCard({ status }: { status: ProviderStatus }) {
  const badge = !status.configured
    ? { text: 'Not configured', className: 'bg-gray-200 text-gray-600' }
    : status.ok
      ? { text: 'Online', className: 'bg-green-100 text-green-700' }
      : { text: 'Failing', className: 'bg-red-100 text-red-700' }

  return (
    <div className="border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium text-gray-900">{status.name}</span>
        <span className={`text-xs font-medium px-2 py-1 rounded-full ${badge.className}`}>{badge.text}</span>
      </div>
      {status.latencyMs !== null && (
        <p className="text-sm text-gray-500">{status.latencyMs}ms</p>
      )}
      {status.error && <p className="text-sm text-red-600 mt-1">{status.error}</p>}
    </div>
  )
}

export function AdminPage() {
  const [password, setPassword] = useState('')
  const [loggedIn, setLoggedIn] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoginError(null)
    const res = await fetch('/api/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) {
      setLoggedIn(true)
      fetchStatus()
    } else {
      const data = await res.json().catch(() => ({}))
      setLoginError(data.error || 'Login failed')
    }
  }

  async function fetchStatus() {
    setLoading(true)
    try {
      const res = await fetch('/api/admin-status')
      if (res.status === 401) {
        setLoggedIn(false)
        return
      }
      const data = await res.json()
      setStatus(data)
      setCheckedAt(new Date())
    } finally {
      setLoading(false)
    }
  }

  if (!loggedIn) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-16">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-semibold text-gray-900 mb-6">Admin</h1>
          <form onSubmit={handleLogin} className="flex flex-col gap-2">
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              className="border border-gray-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <button
              type="submit"
              className="bg-gray-900 hover:bg-gray-800 text-white font-medium px-5 py-3 rounded-lg"
            >
              Log in
            </button>
          </form>
          {loginError && <p className="text-red-600 text-sm mt-3">{loginError}</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-16">
      <div className="w-full max-w-xl">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-gray-900">LLM status</h1>
          <button
            onClick={fetchStatus}
            disabled={loading}
            className="text-sm bg-gray-900 hover:bg-gray-800 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg"
          >
            {loading ? 'Testing…' : 'Test now'}
          </button>
        </div>

        {status ? (
          <div className="flex flex-col gap-3">
            <ProviderCard status={status.primary} />
            <ProviderCard status={status.backup} />
            {checkedAt && (
              <p className="text-xs text-gray-400">Last checked {checkedAt.toLocaleTimeString()}</p>
            )}
          </div>
        ) : (
          <p className="text-gray-400 text-sm">Loading…</p>
        )}

        <p className="text-xs text-gray-400 mt-8">
          Each check runs a real extraction call against the model with a tiny test recipe, so a slow or failing
          model here reflects what a real request would hit right now — it is not a cached status.
        </p>
      </div>
    </div>
  )
}
