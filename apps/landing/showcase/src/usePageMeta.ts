import { useEffect } from 'react'

// Per-route SEO overrides for this SPA. showcase/index.html's own
// <title>/meta tags are shared by every route under /showcase/* (there's
// no SSR here, so that static HTML is also all a crawler that doesn't
// execute JS ever sees) — this hook lets an individual case route
// (e.g. /showcase/support) present its own title/description/OG/Twitter
// tags to anything that DOES run JS (browser tabs, link-preview bots that
// execute scripts, social share cards fetched after the page settles),
// without needing a build-time SSR/prerender setup for a handful of demo
// pages. Restores index.html's own defaults on unmount, so navigating
// back to the case list (which never calls this hook) doesn't leak one
// demo's title into another route.
interface PageMeta {
  title: string
  description: string
  // Optional: only routes that want their own shareable/canonical URL
  // (rather than inheriting index.html's default "/showcase/") need to
  // pass this — e.g. a case page a visitor might bookmark or share
  // directly, as opposed to a route that's more of a step in a flow.
  path?: string
}

const SHOWCASE_ORIGIN = 'https://onagent.shuttle.tools/showcase'

const DEFAULT_META: PageMeta = {
  title: 'Showcase — onagent',
  description: 'Try the live marketing analytics assistant demo — a real AgentBridge connection, not a mock.',
  path: '/',
}

function setMetaTag(selector: string, content: string) {
  const el = document.querySelector(selector)
  if (el) el.setAttribute('content', content)
}

function applyMeta(meta: PageMeta) {
  document.title = meta.title
  setMetaTag('meta[name="description"]', meta.description)
  setMetaTag('meta[property="og:title"]', meta.title)
  setMetaTag('meta[property="og:description"]', meta.description)
  setMetaTag('meta[name="twitter:title"]', meta.title)
  setMetaTag('meta[name="twitter:description"]', meta.description)
  if (meta.path !== undefined) {
    const url = `${SHOWCASE_ORIGIN}${meta.path === '/' ? '/' : `/${meta.path.replace(/^\//, '')}`}`
    setMetaTag('meta[property="og:url"]', url)
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', url)
  }
}

export function usePageMeta(meta: PageMeta) {
  useEffect(() => {
    applyMeta(meta)
    return () => applyMeta(DEFAULT_META)
    // Re-applies whenever these change (e.g. a future language toggle at
    // this level) — not just on mount/unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.title, meta.description, meta.path])
}
