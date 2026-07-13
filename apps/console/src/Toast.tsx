import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface ToastItem {
  id: number
  message: string
  kind: 'error' | 'info'
}

interface ToastContextValue {
  /** Show a dismissible, auto-expiring notification instead of a native alert(). */
  showToast: (message: string, kind?: 'error' | 'info') => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const AUTO_DISMISS_MS = 6000

// Provider + host in one component: mount once near the app root. Toasts
// stack (most recent at top) rather than replacing each other, so a second
// error while the first is still visible doesn't silently swallow the first.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id))
  }, [])

  const showToast = useCallback(
    (message: string, kind: 'error' | 'info' = 'error') => {
      const id = nextId.current++
      setToasts((cur) => [...cur, { id, message, kind }])
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-message">{t.message}</span>
            <button type="button" className="toast-dismiss" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

// Throws if used outside ToastProvider — a missing provider is a wiring bug
// that should fail loudly in development, not silently no-op.
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}
