// gtag is loaded by the base tag in index.html (site-wide, on every page) —
// not imported, just declared here so TypeScript knows it exists. Firing it
// is exactly this — a plain window global call — not something that can be
// expressed as a static HTML tag, since it has to happen at the moment a
// registration actually succeeds, not on every page load.
declare function gtag(...args: unknown[]): void

// Fires once per real new registration. Two call sites, for the two ways an
// account gets created:
//   - Login.tsx's submit(), gated on mode === 'register' succeeding —
//     api.register only ever resolves on a genuine new account (an email
//     already in use is a thrown ApiError instead).
//   - App.tsx's ?new=1 check, set only when backend/internal/googleauth's
//     callback just created a brand-new account via Google sign-in — the
//     only signal that distinguishes that from a returning user's login,
//     since both land back on the console with a session cookie already
//     set and never render Login.tsx at all.
// Fires by default — set VITE_DISABLE_ANALYTICS=true in .env.local while
// testing registrations locally so they don't inflate the real GA4/Ads
// conversion counts. Unset (or anything other than "true") means "send."
export function fireRegistrationConversion() {
  if (typeof gtag !== 'function') return // gtag.js failed to load — don't throw over an ads pixel
  if (import.meta.env.VITE_DISABLE_ANALYTICS === 'true') return
  gtag('event', 'sign_up')
  gtag('event', 'conversion', { send_to: 'AW-18416841975/eynPCLjd_OocEPfp6s1E' })
}

// --- declarative click tracking ------------------------------------------
//
// For "did someone click this" events (as opposed to fireRegistrationConversion
// above, which fires from a conditional deep in async login/register logic,
// not a click), a component marks the element with data-track instead of
// importing and calling a fire*() function. One delegated listener here
// does the actual gtag call. This means:
//   - Adding a new tracked click is one JSX attribute, no analytics.ts
//     import, no new fire*() function to write.
//   - Removing one is deleting that attribute — nothing to hunt down in
//     analytics.ts afterwards.
//   - Swapping providers (GA4 → something else) touches only this file's
//     listener, never the components that set data-track.
//
// Trade-off: the value has to be static markup, not a live JS value — see
// the "name:value" convention below for the common case of a component
// with a couple of fixed variants (a method, a tab, a plan tier). An event
// that needs a genuinely dynamic value (a search query, a computed count)
// still belongs in a one-off fire*() call.

// data-track's value is "eventName" or "eventName:value" — the part after
// the colon (if present) becomes { value } on the GA4 event so a handful of
// fixed variants of the same event (e.g. which of two buttons was clicked)
// don't need one event name each. Delegated on document so it keeps working
// for elements that mount after this listener is attached — no per-element
// wiring required.
function handleTrackedClick(e: MouseEvent) {
  const el = (e.target as Element | null)?.closest('[data-track]')
  if (!el) return
  const [eventName, value] = (el.getAttribute('data-track') ?? '').split(':')
  if (!eventName) return
  if (typeof gtag !== 'function') return
  if (import.meta.env.VITE_DISABLE_ANALYTICS === 'true') return
  gtag('event', eventName, value ? { value } : undefined)
}

// Idempotent — safe to call more than once (e.g. React StrictMode's double
// invoke, or a test suite's beforeEach re-running per test) since it always
// removes its own listener before adding it back, rather than stacking a
// new listener on document every call.
export function installClickTracking() {
  document.removeEventListener('click', handleTrackedClick)
  document.addEventListener('click', handleTrackedClick)
}
