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
  return (
    <BottomSheet open={open} onClose={onClose} fullscreen>
      <div className={styles.header}>
        <SheetHeader title="Playground" onClose={onClose} />
      </div>
      <div className={styles.body}>{appId && <Playground appId={appId} tools={tools} />}</div>
    </BottomSheet>
  )
}
