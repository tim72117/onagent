import styles from './AppShell.module.css'

// The console's top-level layout skeleton — a two-column grid (sidebar +
// main) that collapses to a single column below 860px (MobileNav.tsx takes
// over navigation at that width instead, see App.tsx). Named slots (not a
// single `children`) since this is a fixed two-region layout, not a
// generic wrapper — there's exactly one sidebar and one main region, not
// an arbitrary list of children.
//
// Deliberately simple: no forwardRef, no unbounded/variant props. Unlike
// tripace's DesktopLayoutShell/DesktopMain (which earned their own
// components by being reused across 3+ independent pages), this shell
// currently has exactly one caller (App.tsx) — the value here is scoping
// the grid rule into its own module and giving the layout a named,
// typed seam, not eliminating duplication that doesn't exist yet. Add
// ref-forwarding or layout variants only when an actual second caller
// needs them, not preemptively.
export function AppShell({
  sidebar,
  main,
  children,
}: {
  sidebar: React.ReactNode
  main: React.ReactNode
  // Modals/overlays that sit outside the grid (KeyModal, ConfirmModal,
  // etc. in App.tsx) — they're not part of the two-region layout, just
  // rendered alongside it.
  children?: React.ReactNode
}) {
  return (
    <div className={styles.shell}>
      {/* .shell is a CSS grid — without this wrapper, the `sidebar` slot's
          two children (MobileNav + Sidebar, see App.tsx) would each become
          their own implicit grid item/row instead of one, leaving `main`'s
          row position to fall out of DOM order rather than the explicit
          two-column layout below expects. */}
      <div className={styles.sidebarSlot}>{sidebar}</div>
      {main}
      {children}
    </div>
  )
}
