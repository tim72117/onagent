import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { CliAuthPage } from './CliAuthPage'
import { ToastProvider } from './Toast'
import './style.css'

// No router dependency for one extra path — a plain pathname check is
// enough for a single special-purpose page.
const page = window.location.pathname === '/cli-auth' ? <CliAuthPage /> : <App />

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>{page}</ToastProvider>
  </StrictMode>,
)
