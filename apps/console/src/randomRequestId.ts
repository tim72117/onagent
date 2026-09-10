// crypto.randomUUID() only exists in a secure context (HTTPS, or
// http://localhost specifically) — loading the console over plain HTTP via
// any other hostname (e.g. a Tailscale IP, or a plain LAN IP during mobile
// testing) makes the whole Web Crypto API, including this function, simply
// undefined rather than merely less secure, throwing
// "crypto.randomUUID is not a function" the moment it's called.
//
// Playground.tsx's own sendPrompt needs this requestId to be genuinely
// globally unique (not just unique within one page load) — the backend
// uses it as a quota idempotency key against usage_events(app_id,
// event_id), so a collision would mean a real prompt silently isn't
// counted (or double-counted). Falls back to a Math.random()-built
// UUID-v4-shaped string rather than failing outright when crypto.randomUUID
// is unavailable — not cryptographically secure, but collision-resistant
// enough for this purpose (a correlation/idempotency key, not a security
// token).
export function randomRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
