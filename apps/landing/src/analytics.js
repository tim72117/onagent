// Declarative click tracking for the landing site — same design as
// apps/console/src/analytics.ts's installClickTracking, reimplemented here
// as its own plain-JS module rather than shared code, since this app has
// no framework/bundler dependency on console's build (landing is a
// vanilla-JS static site; console is React). Keeping the same pattern in
// both means adding or removing a tracked click anywhere on the site is
// always the same one-line change: an HTML attribute, no analytics import,
// no new function+call-site pair to write or delete.
//
// An element marked with data-track="eventName" or
// data-track="eventName:value" fires a dataLayer.push through one
// delegated listener when clicked. The GTM container loaded by this page
// (GTM-MXMK83XR, same container as console — see index.html's <head>)
// owns which GA4/Ads tag actually reacts to that push; this file only ever
// pushes plain events, never calls gtag() directly.
//
// Respects the same VITE_DISABLE_ANALYTICS escape hatch as the GTM loader
// script in this page's <head>, so local dev never sends real events —
// see apps/landing/.env.example.

function pushToDataLayer(event) {
  if (import.meta.env.VITE_DISABLE_ANALYTICS === 'true') return
  window.dataLayer = window.dataLayer || []
  window.dataLayer.push(event)
}

function handleTrackedClick(e) {
  const el = e.target instanceof Element ? e.target.closest('[data-track]') : null
  if (!el) return
  const [eventName, value] = (el.getAttribute('data-track') ?? '').split(':')
  if (!eventName) return
  pushToDataLayer(value ? { event: eventName, value } : { event: eventName })
}

// Idempotent — safe to call more than once (e.g. a page that imports this
// module from more than one entry script) since it always removes its own
// listener before adding it back, rather than stacking a new listener on
// document every call.
export function installClickTracking() {
  document.removeEventListener('click', handleTrackedClick)
  document.addEventListener('click', handleTrackedClick)
}
