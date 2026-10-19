import type { ReactNode } from 'react'
import { Navigate, Routes, Route } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { RecipePage } from './pages/RecipePage'
import { AdminPage } from './pages/AdminPage'
import { LoginPage } from './pages/LoginPage'
import { AuthProvider, useAuth } from './lib/auth'

// The library needs a session (invited user or trial). Recipe pages stay reachable without
// one because a recipe shared with "anyone with the link" is readable by logged-out visitors;
// the database decides what they can actually see.
function RequireSession({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()
  if (loading) {
    return <div className="min-h-screen bg-gray-50 flex items-center justify-center text-gray-400">Loading…</div>
  }
  if (!session) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route
          path="/"
          element={
            <RequireSession>
              <HomePage />
            </RequireSession>
          }
        />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/recipe/:id" element={<RecipePage />} />
        <Route path="/admin" element={<AdminPage />} />
      </Routes>
    </AuthProvider>
  )
}
