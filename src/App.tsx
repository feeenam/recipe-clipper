import { Routes, Route } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { RecipePage } from './pages/RecipePage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/recipe/:id" element={<RecipePage />} />
    </Routes>
  )
}
