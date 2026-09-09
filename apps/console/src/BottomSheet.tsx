import { createContext, useContext, useEffect } from 'react'
import { createPortal } from 'react-dom'
import styles from './BottomSheet.module.css'

// Every BottomSheet's .backdrop/.panel share the same fixed z-index
// (30/31, see BottomSheet.module.css) — fine when only one sheet is ever
// open at a time, but ToolEditSheet.tsx nests four more BottomSheets
// (ToolNameSheet/ToolDescriptionSheet/ToolParametersSheet/
// ToolReturnsSheet) as its own children, each independently
// always-mounted and each portaled to document.body. With identical
// z-index across all of them, which one visually wins is decided by DOM
// order among document.body's children — and every sheet here is
// portaled, so that order isn't guaranteed to track nesting: a nested
// child sheet's portal can land BEFORE its parent's in document.body's
// child list, so the parent's panel renders on top of an already-open
// child. The child's content is still real (its inputs are fillable
// programmatically) but invisible and untappable — "the fields don't
// respond to taps" from the user's side, even though the sheet did open
// underneath. SheetDepthContext tracks how many BottomSheet ancestors a
// given instance has (0 for a top-level sheet, 1 for one nested inside
// another, etc.) so each level gets a z-index strictly above its parent's
// regardless of portal/commit order — nesting depth, not global mount
// history, since depth for this app's actual sheet tree never exceeds 2
// and this must stay well below ConfirmModal's z-index:40 (style.css) no
// matter how many distinct sheet components exist across the whole app.
const SheetDepthContext = createContext(0)

// Small, purpose-built bottom sheet — no drag gestures, no multi-step snap
// points, no stacking support (see /Users/caitingyu/Documents/tripace/web/src/
// components/PhoneBottomSheet.tsx for a much heavier version built for a
// touch-heavy mobile app; this console is desktop-first with a single sheet
// open at a time, so that complexity isn't needed here). Always mounted
// (not conditionally rendered) so open/close both animate via CSS
// transition instead of the close transition being skipped by unmounting.
export function BottomSheet({
  open,
  onClose,
  children,
  fullscreen,
  disableBackdropClose,
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  // See PlaygroundSheet.tsx — a sheet whose content needs the full
  // viewport instead of the partial-height treatment every other sheet
  // uses.
  fullscreen?: boolean
  // Set on every sheet with actual editable fields (KeyEditSheet,
  // OriginEditSheet, ThoughtEditSheet, ToolNameSheet, ToolDescriptionSheet,
  // ToolParametersSheet, ToolReturnsSheet, ToolEditSheet) — a stray tap
  // just outside the sheet while mid-edit (easy to do one-handed on a
  // phone) silently discarding whatever was being typed is worse than
  // requiring the explicit close (X) button. Left enabled (the default)
  // on sheets with no editable state to lose — AppPickerSheet/AccountSheet
  // (pick-and-go, or read-only) and PlaygroundSheet (a live chat, not a
  // form — nothing to accidentally discard).
  disableBackdropClose?: boolean
}) {
  const depth = useContext(SheetDepthContext)
  // +1 per level so a depth-1 sheet's backdrop (31) already outranks its
  // depth-0 parent's panel (30's own base + 1 = 31 too — hence the *2
  // spacing, keeping backdrop-then-panel pairs from ever interleaving
  // across levels): depth 0 → backdrop 30/panel 31, depth 1 → 32/33, etc.
  const zIndexBase = 30 + depth * 2

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  // Without this, a touch-scroll gesture that runs out of room inside the
  // sheet's own scrollable content (or lands on a non-scrolling part of it)
  // falls through to the page underneath — on mobile that scrolls the
  // MobileNav's fixed top/bottom bars along with it (they're positioned
  // relative to the page, not immune to it just because they're `fixed`),
  // making them visibly slide despite this sheet supposedly covering the
  // whole screen. Restores the previous inline value (usually '') on
  // close/unmount rather than hardcoding '', so this composes correctly on
  // the rare chance something else ever sets body overflow too.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  // Portaled to document.body instead of rendering in place — some callers
  // (ThoughtEditSheet.tsx, ToolEditSheet.tsx) live inside
  // MobileWorkspaceCards.module.css's .root, which sets
  // -webkit-overflow-scrolling: touch for its own momentum scrolling. A
  // position:fixed descendant of an element with that property is a
  // long-standing WebKit/iOS Safari quirk: instead of staying pinned to the
  // viewport, it gets trapped as if positioned relative to that scrolling
  // ancestor, so it scrolls (and gets clipped/obscured by the fixed
  // MobileTopBar/MobileBottomBar) along with the container instead of
  // covering the real viewport. Portaling every sheet to document.body
  // sidesteps this regardless of which caller's DOM subtree it's declared
  // in — PlaygroundSheet.tsx never hit this only because MobileNav.tsx (its
  // parent) happens not to use that property, not because BottomSheet
  // itself was fine.
  return createPortal(
    <>
      <div
        className={`${styles.backdrop} ${open ? styles.open : ''}`}
        style={{ zIndex: zIndexBase }}
        onClick={disableBackdropClose ? undefined : onClose}
        aria-hidden="true"
      />
      <div
        className={`${styles.panel} ${open ? styles.open : ''}${fullscreen ? ' ' + styles.fullscreen : ''}`}
        style={{ zIndex: zIndexBase + 1 }}
        role="dialog"
        aria-modal="true"
      >
        <SheetDepthContext.Provider value={depth + 1}>{children}</SheetDepthContext.Provider>
      </div>
    </>,
    document.body,
  )
}
