import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './base.css'
import './cases/marketing/marketing.css'
import './cases/support/support.css'

const root = document.getElementById('root')
if (!root) throw new Error('showcase: #root element not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
