// Focuses el, then scrolls it into view once the on-screen keyboard has
// actually finished opening (visualViewport's resize event) — a fixed
// setTimeout guess can't know how long that animation takes on a given
// device, and firing scrollIntoView before the keyboard has resized the
// visible area just scrolls to a position that's about to be wrong again.
//
// Still needed even with index.html's interactive-widget=resizes-content
// (which correctly shrinks a fullscreen BottomSheet's own position:fixed
// panel around the keyboard): that only fixes the *panel's* geometry, not
// the *scroll position* within it — an input already sitting at the
// bottom edge of the panel can still end up right under the keyboard once
// the panel shrinks, since nothing about focus() or the resize itself
// scrolls this specific input into the now-smaller visible area.
//
// Falls back to a single scrollIntoView after 400ms if no resize event
// arrives at all (e.g. the keyboard was already open from a previous
// field, so opening this one doesn't change the visual viewport size).
export function focusAndReveal(el: HTMLElement | null) {
  if (!el) return
  el.focus()

  const vv = window.visualViewport
  if (!vv) return

  let done = false
  const timer = setTimeout(reveal, 400)

  function reveal() {
    if (done) return
    done = true
    clearTimeout(timer)
    vv!.removeEventListener('resize', reveal)
    el!.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  vv.addEventListener('resize', reveal)
}
