import { MarketingCase } from './cases/marketing/MarketingCase'
import { SupportCase } from './cases/support/SupportCase'

// Case list ("/showcase/") — the only route with the shared "Live demo"
// banner (index.html used to render this as static chrome shared by every
// route; moved here so /marketing and /support render only their own
// content, with no leftover list-page banner above them).
//
// One case per component (illustration + copy, ending in a <Link> to its
// own route in App.tsx) rather than in-page state, so sharing/reloading a
// case's URL lands directly on its demo. Adding a third case is one more
// cases/<name>/ directory plus one more <Route>, not a restructuring of
// this file.
export function ShowcaseList() {
  return (
    <>
      <div className="head">
        <span className="eyebrow"><span className="dot" />Live demo</span>
        <h1>See onagent<br /><span className="g">answer real questions about real data.</span></h1>
        <p>A live AgentBridge connection, not a recording — describe what you want to know and watch it pick the right analysis method.</p>
      </div>
      <div className="case-list">
        <MarketingCase />
        <div className="case-divider" />
        <SupportCase />
      </div>
    </>
  )
}
