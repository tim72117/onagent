import { useLayoutEffect, useState } from 'react'

export type PopoverPlacement = {
  vertical: 'top' | 'bottom'
  horizontal: 'left' | 'right'
}

// Decides which side of an anchor element a popover should open toward, so
// it never renders partly off-screen. Both Playground.tsx's help popover
// and ThoughtEditor.tsx's platform-default popover used to hardcode
// "below and left-aligned" — fine near the top-left of the viewport, but a
// trigger near the right edge (a narrow phone, a sidebar-embedded
// Playground) pushed the popover's right edge past the window, and one
// near the bottom (a long transcript scrolled down) could do the same
// vertically.
//
// anchorRef must point at the same element the popover is positioned
// relative to (both callers use position:relative on that element, with
// the popover itself position:absolute inside it) — this hook only reads
// its bounding rect, it doesn't create the positioning context itself.
//
// Recomputed via useLayoutEffect (not useEffect) so the placement is
// correct on the very first paint the popover is visible — an effect that
// ran after paint would show it in the wrong spot for one frame, then jump,
// which reads as a visible glitch for something that should feel instant.
export function usePopoverPlacement(open: boolean, anchorRef: React.RefObject<HTMLElement | null>): PopoverPlacement {
  const [placement, setPlacement] = useState<PopoverPlacement>({ vertical: 'bottom', horizontal: 'left' })

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    // Popovers here are roughly 280-320px wide and well under half the
    // viewport tall — checking against the anchor's own distance to each
    // edge (rather than measuring the popover itself, which hasn't
    // rendered yet on the frame this decision is made) is enough to catch
    // the cases that actually occur: a trigger near the right or bottom
    // edge of the viewport.
    setPlacement({
      vertical: window.innerHeight - rect.bottom < 220 ? 'top' : 'bottom',
      horizontal: window.innerWidth - rect.left < 320 ? 'right' : 'left',
    })
  }, [open, anchorRef])

  return placement
}
