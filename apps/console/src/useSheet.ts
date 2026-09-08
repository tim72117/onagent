import { useState } from 'react'

// Every bottom sheet/drawer in this app (MobileNav.tsx's app picker/
// account/playground sheets, AppSettingsList.tsx's key/origin sheets,
// MobileWorkspaceCards.tsx's thought sheet, ToolEditSheet.tsx's four
// field sheets) followed the same shape — a boolean useState plus two
// inline closures to flip it — with nothing distinguishing one from
// another beyond the variable name. Collapsing that repetition here so a
// new sheet is one line, not three.
export function useSheet(initialOpen = false) {
  const [open, setOpen] = useState(initialOpen)
  return {
    open,
    onOpen: () => setOpen(true),
    onClose: () => setOpen(false),
  }
}
