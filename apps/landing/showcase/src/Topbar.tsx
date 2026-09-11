import styles from './Topbar.module.css'

// The showcase app's page chrome — previously static markup in
// index.html; moved into React (see main.tsx) specifically so it can use
// CSS Modules' hashed class names like every other component here. Static
// HTML outside #root has no way to reference a module's generated names,
// which is exactly the gap the old ".tag" class-name collision (index.html
// used a bare ".tag" span for decoration text; base.css's own ".tag" rule,
// for feature-tag bubbles, absolutely-positioned it) fell into — Modules
// make that whole category of bug impossible, not just less likely.
export function Topbar() {
  return (
    <>
      <div className={styles.bgFx} />
      <header className={styles.topbar}>
        <a className={styles.brand} href="../index.html">
          <span className={styles.mark}>⌘</span>
          onagent
          <span className={styles.sep}>/</span>
          <span className={styles.suffix}>showcase</span>
        </a>
        <div className={styles.links}>
          <a href="../index.html">Home</a>
          <a href="/pricing/">Pricing</a>
          <a href="/docs/">Docs</a>
        </div>
      </header>
    </>
  )
}
