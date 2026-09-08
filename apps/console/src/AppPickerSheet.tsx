import type { AppSummary } from './api'
import { AppList } from './AppList'
import { BottomSheet } from './BottomSheet'
import styles from './AppPickerSheet.module.css'

// Mobile-only — opened by tapping the app name/chevron in MobileTopBar.tsx.
// Reuses AppList.tsx (the same "section heading + selectable row list"
// shared with the desktop Sidebar and AgentNav/ToolList), presented in a
// bottom sheet.
export function AppPickerSheet({
  open,
  onClose,
  summaries,
  activeAppId,
  onSelectApp,
}: {
  open: boolean
  onClose: () => void
  summaries: AppSummary[]
  activeAppId: string | null
  onSelectApp: (appId: string) => void
}) {
  return (
    <BottomSheet open={open} onClose={onClose}>
      <div className={styles.list}>
        <AppList
          summaries={summaries}
          activeAppId={activeAppId}
          rowClassName={styles.row}
          onSelectApp={(id) => {
            onSelectApp(id)
            onClose()
          }}
        />
      </div>
    </BottomSheet>
  )
}
