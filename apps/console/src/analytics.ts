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
