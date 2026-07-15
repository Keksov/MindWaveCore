// TT1.1 — where a tooltip goes so the mouse cursor never covers it (tooltip-placement plan, TT-D1/D3).
//
// This module is the single source of truth for the placement rule (owner req. 1), shared by every
// tooltip in the project: AppTooltip's cursor mode calls it directly, and its element mode expresses
// the same rule declaratively through QTooltip's anchor/self props.
//
// Why "above" is the rule: the standard arrow cursor's hotspot is its TIP (top-left corner) and the
// glyph extends DOWN-RIGHT from it (~20x20 CSS px at 100%). So anything drawn below-right of the
// pointer is covered by the cursor itself — which is exactly what the owner reported (req 2). Nothing
// drawn ABOVE the hotspot is ever covered by the arrow. Cursors with a centred hotspot (crosshair on
// the canvases, the text I-beam, ns-/ew-resize) do extend upward, but only by ~10-16px, so a single
// clearance constant covers both families.
//
// Pure and Vue-free on purpose, so the rule is unit-testable without mounting anything.

/**
 * Vertical gap kept between the cursor hotspot and the tooltip box.
 *
 * 24px clears the ~20px arrow glyph and the upper half of a crosshair. It cannot adapt to Windows'
 * "large cursor" accessibility setting — the cursor size is not readable from the browser — but that
 * only matters for the fallback (below) placement: the primary (above) placement is unaffected by
 * cursor size, because the arrow only ever grows down-right. Raise this if a large-cursor user
 * complains (tooltip-placement plan, R3).
 */
export const CURSOR_CLEARANCE_PX = 24

/** Horizontal step away from the hotspot. Matches the pre-existing hand-rolled tooltips. */
export const CURSOR_OFFSET_X_PX = 14

/** Minimum gap kept between the tooltip and the edge of `bounds`. */
export const EDGE_PAD_PX = 8

/**
 * Room an element needs above it before a tooltip may be anchored there (element mode).
 *
 * = QTooltip's 14px offset + a one-or-two-line tooltip (~24-36px at the 10px tooltip font). Elements
 * closer to the top of the window than this get the below-with-clearance fallback chosen by US,
 * rather than letting QTooltip's position engine discover the overflow and flip them itself.
 *
 * That distinction is the whole point, and it is not cosmetic. When applyBoundaries() nudges a
 * tooltip back inside the viewport it also pins max-height to the tooltip's own ROUNDED
 * offsetHeight; a fractional content height then overflows that integer box by a sub-pixel and
 * .q-tooltip's `overflow-y: auto` renders a scrollbar on a single line of text (owner report,
 * 2026-07-15: the header status icons). Choosing the side ourselves keeps props.top > 0, so the
 * engine never applies boundaries, never sets max-height, and never scrolls — and the fallback still
 * clears the cursor, which QTooltip's own flip (a flat 14px) does not.
 *
 * Deliberately tight: it must NOT catch the main toolbars, whose tooltips read correctly above.
 */
export const MIN_ROOM_ABOVE_PX = 48

/**
 * Can a tooltip be anchored above an element whose top edge is `anchorTopPx` from the viewport top?
 * Anything else goes below with `CURSOR_CLEARANCE_PX` — which still satisfies the rule, since the
 * cursor sits inside the element and the arrow glyph only ever grows down-right.
 */
export function hasRoomAbove(anchorTopPx: number, minRoom: number = MIN_ROOM_ABOVE_PX): boolean {
  return anchorTopPx >= minRoom
}

/** The box the tooltip must stay inside — normally the viewport (innerWidth/innerHeight). */
export interface TooltipBounds {
  width: number
  height: number
}

export interface PlaceCursorTooltipInput {
  /** Cursor hotspot, in the same coordinate space as `bounds` (viewport coords for position:fixed). */
  x: number
  y: number
  /** Measured tooltip size. Callers must measure AFTER render (offsetWidth/offsetHeight). */
  w: number
  h: number
  bounds: TooltipBounds
  clearance?: number
  pad?: number
}

export interface TooltipPos {
  left: number
  top: number
}

/** Clamp that degrades sanely when the range is inverted (box larger than bounds): `min` wins. */
function clampRange(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * Place a cursor-following tooltip so the cursor cannot cover its text.
 *
 * Vertical (the part that matters): ABOVE the hotspot by `clearance`. Only when that would leave the
 * top edge of `bounds` does it fall back to BELOW — and then still by `clearance`, so the arrow glyph
 * clears the text rather than sitting on it. Note this is the opposite of a naive "flip only when it
 * overflows": we start above and flip down, never the reverse.
 *
 * Horizontal: `CURSOR_OFFSET_X_PX` to the right of the hotspot, flipping to the left near the right
 * edge. Once the box is above the hotspot the arrow can't reach it, so this is about staying on
 * screen, not about the cursor.
 *
 * Both axes are clamped into `bounds` last. In a viewport too short for the tooltip to fit either
 * side (roughly height < 2h + 64) the clamp wins and some overlap is unavoidable.
 */
export function placeCursorTooltip(input: PlaceCursorTooltipInput): TooltipPos {
  const { x, y, w, h, bounds } = input
  const clearance = input.clearance ?? CURSOR_CLEARANCE_PX
  const pad = input.pad ?? EDGE_PAD_PX

  let top = y - h - clearance
  if (top < pad) top = y + clearance

  let left = x + CURSOR_OFFSET_X_PX
  if (left + w + pad > bounds.width) left = x - w - CURSOR_OFFSET_X_PX

  return {
    left: clampRange(left, pad, bounds.width - w - pad),
    top: clampRange(top, pad, bounds.height - h - pad),
  }
}
