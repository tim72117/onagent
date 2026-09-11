import { useEffect, useRef, useState } from 'react'

declare global {
  interface Window {
    dataLayer?: unknown[]
  }
}

// ../../../../src/marketing-demo/widget.js stays plain, untyped JS (see
// the import below's own comment); this is the minimal shape actually
// called here, cast onto the dynamic import's result rather than an
// ambient module declaration — a relative-path `declare module` for a
// dynamic import specifier is unreliable under "moduleResolution":
// "bundler", so a narrow inline type is the more robust fix for the sake
// of a single call site.
type MarketingDemoModule = {
  mountMarketingDemo: (hostEl: HTMLElement, options?: { lang?: 'en' | 'zh' }) => { openCode: () => void }
}

// Bridges React to the existing vanilla marketing-demo widget
// (apps/landing/src/marketing-demo/widget.js's mountMarketingDemo) rather
// than rewriting it as a React component — that widget already renders
// into its own Shadow DOM (see mountMarketingDemo's own doc comment on
// why: full style isolation from the host page), so it has nothing to
// gain from being React-managed and every reason to stay the single
// implementation homepage index.html's modal and this page both mount
// unchanged.
//
// Only rendered once React Router navigates here (App.tsx's "/marketing"
// route) — the dynamic import is what actually defers fetching the widget
// module (and its @onagent/bridge dependency) until that navigation, not
// page load; visiting /showcase/ (ShowcaseList) never pays for it.
export function MarketingDemo() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    window.dataLayer = window.dataLayer || []
    window.dataLayer.push({ event: 'demo_open', demo_id: 'showcase-marketing' })
    import('../../../../src/marketing-demo/widget.js').then((mod) => {
      if (cancelled || !hostRef.current) return
      ;(mod as MarketingDemoModule).mountMarketingDemo(hostRef.current, { lang: 'en' })
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
    // Runs once on mount — this component's whole lifetime IS one demo
    // session (React Router unmounts/remounts it on navigation away and
    // back, which is exactly when a fresh session is wanted).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="demo-panel">
      {loading && <div className="demo-loading">Loading demo…</div>}
      <div ref={hostRef} style={{ display: loading ? 'none' : undefined }} />
    </div>
  )
}
