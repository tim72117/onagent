import styles from './ShowcaseList.module.css'
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
export function ShowcaseList() {
  return (
    <>
      <div className={styles.head}>
        <span className={styles.eyebrow}><span className={styles.dot} />Live demo</span>
        <h1>See onagent<br /><span className={styles.gradText}>answer real questions about real data.</span></h1>
        <p>A live AgentBridge connection, not a recording — describe what you want to know and watch it pick the right analysis method.</p>
      </div>
      <div className={styles.caseList}>
        <MarketingCase />
        <div className={styles.caseDivider} />
        <SupportCase />
      </div>
    </>
  )
}
