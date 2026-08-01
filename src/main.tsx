import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import './index.css'
import App from './App.tsx'
import { loadAppPrefs } from './lib/prefs.ts'
import { revealMainWindowWhenReady } from './lib/windowAppearance.ts'

async function bootstrap() {
  const initialPrefs = await loadAppPrefs()
  const root = createRoot(document.getElementById('root')!)
  flushSync(() => {
    root.render(
      <StrictMode>
        <App initialPrefs={initialPrefs} />
      </StrictMode>,
    )
  })
  void revealMainWindowWhenReady()
}

void bootstrap()
