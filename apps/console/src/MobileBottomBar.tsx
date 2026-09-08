import styles from './MobileBottomBar.module.css'

// Mobile-only fixed bottom bar — a single, centered Playground button
// (opens PlaygroundSheet.tsx, a full-screen sheet). See MobileNav.tsx,
// which owns that sheet's open state and renders this alongside it. Empty
// otherwise by design — this isn't a general-purpose tab bar, just the
// one entry point Playground needs since it's no longer one of the
// mobile card-stack's cards (see App.tsx's card-stack rendering for
// Agent Thought/Tools).
export function MobileBottomBar({ onOpenPlayground }: { onOpenPlayground: () => void }) {
  return (
    <div className={styles.bar}>
      <button type="button" className={styles.playgroundBtn} onClick={onOpenPlayground}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
          <path d="M5 3l14 9-14 9V3z" />
        </svg>
        Playground
      </button>
    </div>
  )
}
