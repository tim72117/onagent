// Menu.vue reads document.querySelector('meta[name="csrf-token"]') directly
// in its data() (a holdover from this component's Laravel/Inertia origin —
// see the form POST in its template) and throws immediately on mount if
// that tag isn't present. The real app's index.html provides it; jsdom's
// blank document doesn't, so every test needs it injected once up front.
const meta = document.createElement('meta')
meta.setAttribute('name', 'csrf-token')
meta.setAttribute('content', 'test-csrf-token')
document.head.appendChild(meta)

// jsdom doesn't implement ResizeObserver (a real browser API), which
// Vuetify's VApp layout system (createLayout -> layoutSizes) uses
// internally and throws on if it's missing entirely. Tests don't care
// about real resize behavior, so a no-op stub is enough to let Vuetify's
// layout setup run without crashing.
class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub
