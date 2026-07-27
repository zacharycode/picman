import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { loadAppPrefs } from './lib/prefs.ts'

async function bootstrap() {
  const initialPrefs = await loadAppPrefs()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App initialPrefs={initialPrefs} />
    </StrictMode>,
  )
}

void bootstrap()
