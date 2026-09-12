import type { AppSummary } from './api'
import type { Tool } from './schema'
import { MobileTopBar } from './MobileTopBar'
import { MobileBottomBar } from './MobileBottomBar'
import { AppPickerSheet } from './AppPickerSheet'
import { AccountSheet } from './AccountSheet'
import { PlaygroundSheet } from './PlaygroundSheet'
import { useSheet } from './useSheet'
import styles from './MobileNav.module.css'

// Sole mobile entry point — a fixed top bar (app picker + account avatar,
// see MobileTopBar.tsx) and a fixed bottom bar (Playground trigger, see
// MobileBottomBar.tsx), plus the overlays they open: the app picker
// bottom sheet (AppPickerSheet.tsx), the account settings sheet
// (AccountSheet.tsx, reached via the top bar's avatar button), and the
// full-screen Playground sheet (PlaygroundSheet.tsx). All opens are
// transient UI state only this component and its children care about, so
// they're kept here rather than lifted to App.tsx.
//
// No hamburger drawer any more (MobileSidebar.tsx, deleted) — it held an
// AppList before app switching moved into the top bar's own picker, then
// just the avatar once that moved up too; once both left, it had nothing
// in it.
export function MobileNav({
  userEmail,
  summaries,
  activeAppId,
  tools,
  onSelectApp,
  onAddApp,
  onLogout,
  onSelectAppSettings,
  playground,
}: {
  userEmail: string
  summaries: AppSummary[]
  activeAppId: string | null
  tools: Tool[] | null
  onSelectApp: (appId: string) => void
  onAddApp: () => void
  onLogout: () => void
  onSelectAppSettings: () => void
  // Lifted to App.tsx (see its own comment) so MobileWorkspaceCards.tsx's
  // "Try it in Playground" button can open this same sheet — no longer
  // owned here.
  playground: ReturnType<typeof useSheet>
}) {
  const appPicker = useSheet()
  const account = useSheet()

  return (
    <div className={styles.root}>
      <MobileTopBar
        activeAppId={activeAppId}
        hasApps={summaries.length > 0}
        userEmail={userEmail}
        onOpenAppPicker={appPicker.onOpen}
        onOpenAccountSheet={account.onOpen}
        onOpenAppSettings={onSelectAppSettings}
      />

      <AppPickerSheet
        open={appPicker.open}
        onClose={appPicker.onClose}
        summaries={summaries}
        activeAppId={activeAppId}
        onSelectApp={onSelectApp}
      />

      <AccountSheet open={account.open} onClose={account.onClose} userEmail={userEmail} onLogout={onLogout} />

      <PlaygroundSheet open={playground.open} onClose={playground.onClose} appId={activeAppId} tools={tools ?? []} />

      {/* Always visible (any sheet/drawer open or closed) — the mobile
          flow's sole "new app" entry point, screen-relative rather than
          living inside a sheet where it'd be hidden most of the time. */}
      <button type="button" className={styles.fab} onClick={onAddApp} aria-label="New app">
        +
      </button>

      <MobileBottomBar onOpenPlayground={playground.onOpen} />
    </div>
  )
}
