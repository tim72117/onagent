import styles from './Footer.module.css'
import { CHROME_STRINGS, type Lang } from './lang'

export function Footer({ lang }: { lang: Lang }) {
  const t = CHROME_STRINGS[lang]
  return (
    <footer className={styles.footer}>
      <div className={`${styles.wrap} ${styles.bottom}`}>
        <span>© 2026 onagent</span>
        <span>
          {/* /privacy/ and /terms/ exist in English only — labels
              translate, hrefs don't, rather than linking to pages that
              aren't there. */}
          <a href="/privacy/">{t.privacy}</a> · <a href="/terms/">{t.terms}</a>
        </span>
      </div>
    </footer>
  )
}
