// Replaces window.confirm — same reasoning as AddAppModal (replacing
// window.prompt) and Toast (replacing window.alert): a native dialog is
// unsupported in some embedding contexts, blocks the whole tab, and can't
// be styled. destructive (default true) picks the confirm button's color;
// confirmLabel names the actual action ("Delete", "Revoke", "Discard",
// "Continue") since a single generic label doesn't fit every caller.
export function ConfirmModal({
  message,
  confirmLabel = 'Continue',
  destructive = true,
  onConfirm,
  onCancel,
}: {
  message: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="modal-overlay" role="alertdialog" aria-modal="true" aria-label="Confirm">
      <div className="modal">
        <p className="modal-copy">{message}</p>
        <div className="modal-actions">
          <button type="button" className="text-btn" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button type="button" className={destructive ? 'primary danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
