import { memo, useEffect, useRef, useState } from 'react'
import type { AppSummary } from './api'
import { AppList } from './AppList'
import styles from './DesktopAppBar.module.css'

// Desktop equivalent of MobileTopBar.tsx's app-picker button — same
// "current app name + chevron" trigger, but opens a dropdown popover
// anchored under the button instead of a full-screen bottom sheet (there's
// no bottom-sheet convention on desktop). Renders AppList.tsx inside the
// popover, the same component the sidebar used to render directly, so the
// row markup/status dots/onAddApp button stay identical — only the
// surrounding chrome (a fixed sidebar section vs. a dismissible popover)
// differs, same split as MobileTopBar/AppPickerSheet already do for mobile.
//
// A permanent bar across the top of the workspace (not just shown once an
// app exists) so app switching stays reachable from every workspace
// screen — Settings, App settings, the tool editor — not just the ones
// that happen to render their own header.
//
// Wrapped in memo since it's mounted unconditionally in App.tsx's JSX
// tree, right alongside state (draft, dirty, thoughtDraft, originDraft...)
// that changes on every keystroke in the tool/thought/origin editors —
// none of which this component's own props (summaries/activeAppId/
// onSelectApp/onAddApp) depend on. Only pays off because App.tsx's
// selectApp/addApp are themselves useCallback now (see their own
// comments) — memo alone can't help if the function props it's comparing
// are fresh closures every render.
export const DesktopAppBar = memo(function DesktopAppBar({
  summaries,
  activeAppId,
  onSelectApp,
  onAddApp,
}: {
  summaries: AppSummary[]
  activeAppId: string | null
  onSelectApp: (appId: string) => void
  onAddApp: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Dropdown-standard dismissal: a real bottom sheet has its own backdrop
  // to tap; this popover doesn't, so it needs its own "click outside
  // closes it" — the one behavior BottomSheet.tsx's mobile sheets get for
  // free from their backdrop that this desktop-only popover has to supply
  // itself.
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className={styles.root} ref={rootRef}>
      <button type="button" className={styles.trigger} onClick={() => setOpen((v) => !v)}>
        <span className={`${styles.triggerLabel}${activeAppId ? '' : ' ' + styles.placeholder}`}>
          {activeAppId ?? 'Select app'}
        </span>
        <svg
          className={`${styles.chevron}${open ? ' ' + styles.chevronOpen : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          width="14"
          height="14"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className={styles.popover} role="menu">
          <AppList
            summaries={summaries}
            activeAppId={activeAppId}
            rowClassName={styles.row}
            onSelectApp={(appId) => {
              onSelectApp(appId)
              setOpen(false)
            }}
            onAddApp={() => {
              onAddApp()
              setOpen(false)
            }}
          />
        </div>
      )}
    </div>
  )
})
