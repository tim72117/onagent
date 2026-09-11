import styles from './Footer.module.css'

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={`${styles.wrap} ${styles.bottom}`}>
        <span>© 2026 onagent</span>
        <span>
          <a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a>
        </span>
      </div>
    </footer>
  )
}
