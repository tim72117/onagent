import styles from './ShowcaseList.module.css'
import { CHROME_STRINGS, type Lang } from './lang'
import { MarketingCase } from './cases/marketing/MarketingCase'
import { SupportCase } from './cases/support/SupportCase'

// Case list ("/showcase/") — the only route with the "Live demo" banner
// (previously static chrome shared by every route; moved here so
// /marketing and /support render only their own content). App.tsx already
// wraps every route's content in shared.wrap, so this renders directly
// into that wrapper rather than nesting a second one.
//
// One case per component (illustration + copy, ending in a <Link> to its
// own route in App.tsx) rather than in-page state, so sharing/reloading a
// case's URL lands directly on its demo. Adding a third case is one more
// cases/<name>/ directory plus one more <Route>, not a restructuring of
// this file.
export function ShowcaseList({ lang }: { lang: Lang }) {
  const t = CHROME_STRINGS[lang]
  return (
    <>
      <div className={styles.head}>
        <span className={styles.eyebrow}><span className={styles.dot} />{t.listEyebrow}</span>
        <h1>{t.listHeadA}<br /><span className={styles.gradText}>{t.listHeadB}</span></h1>
        <p>{t.listSub}</p>
      </div>
      <div className={styles.caseList}>
        <MarketingCase lang={lang} />
        <div className={styles.caseDivider} />
        <SupportCase lang={lang} />
      </div>
    </>
  )
}
