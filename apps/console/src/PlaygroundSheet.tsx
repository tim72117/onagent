import { useState } from 'react'
import type { Tool } from './schema'
import { BottomSheet } from './BottomSheet'
import { SheetHeader } from './SheetHeader'
import { Playground } from './Playground'
import styles from './PlaygroundSheet.module.css'

// Mobile-only — opened via the Playground button in MobileBottomBar.tsx.
// Full-screen (see BottomSheet.tsx's fullscreen prop) since Playground's
// live WebSocket chat needs real screen space, unlike every other sheet
// in this app (AccountSheet.tsx, AppPickerSheet.tsx, KeyEditSheet.tsx,
// OriginEditSheet.tsx), which are partial-height.
export function PlaygroundSheet({
  open,
  onClose,
  appId,
  tools,
}: {
  open: boolean
  onClose: () => void
  appId: string | null
  tools: Tool[]
}) {
  // Mirrors Playground's own header row here, in the row a phone user
  // actually sees without scrolling (this sheet's close-button row),
  // instead of leaving it in Playground's own header further down — see
  // Playground.tsx's hideHeaderInBody/renderHeaderExtras props, which
  // exist for exactly this. The node itself (help popover, connection
  // status pill, Reset context button) is fully rendered by Playground —
  // this sheet just places it, styling and all.
  const [headerExtras, setHeaderExtras] = useState<React.ReactNode>(null)

  return (
    <BottomSheet open={open} onClose={onClose} fullscreen>
      <div className={styles.header}>
        <SheetHeader title="Playground" onClose={onClose} trailing={headerExtras} />
      </div>
      <div className={styles.body}>
        {appId && (
          <Playground
            appId={appId}
            tools={tools}
            hideHeaderInBody
            renderHeaderExtras={setHeaderExtras}
          />
        )}
      </div>
    </BottomSheet>
  )
}
