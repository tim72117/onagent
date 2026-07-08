import { useState } from 'react'

// Replaces window.prompt (unsupported in some embedding contexts) with a
// real controlled input, styled to match KeyModal.
export function AddAppModal({
  onSubmit,
  onClose,
}: {
  onSubmit: (appId: string) => void
  onClose: () => void
}) {
  const [appId, setAppId] = useState('')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = appId.trim()
    if (!trimmed) return
    onSubmit(trimmed)
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="New app">
      <div className="modal">
        <h2 className="modal-title">New app</h2>
        <form onSubmit={submit}>
          <label className="field">
            <span className="micro-label">App id</span>
            <input
              className="modal-input"
              autoFocus
              placeholder="letters, digits, - and _"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button type="button" className="text-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!appId.trim()}>
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
