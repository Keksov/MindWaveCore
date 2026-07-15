import { describe, expect, test } from 'bun:test'

import {
  CURSOR_CLEARANCE_PX,
  CURSOR_OFFSET_X_PX,
  EDGE_PAD_PX,
  placeCursorTooltip,
  type PlaceCursorTooltipInput,
} from './tooltip-place'

/** A roomy viewport plus a typical tooltip, so each test only varies what it is about. */
const VIEW = { width: 1920, height: 1080 }
const W = 200
const H = 60

function place(over: Partial<PlaceCursorTooltipInput> = {}) {
  return placeCursorTooltip({ x: 900, y: 500, w: W, h: H, bounds: VIEW, ...over })
}

describe('placeCursorTooltip — vertical (the rule that matters)', () => {
  test('sits ABOVE the hotspot by the clearance', () => {
    const { top } = place({ y: 500 })
    expect(top).toBe(500 - H - CURSOR_CLEARANCE_PX)
  })

  test('the whole box is above the hotspot, so the arrow glyph cannot reach it', () => {
    const { top } = place({ y: 500 })
    expect(top + H).toBeLessThanOrEqual(500 - CURSOR_CLEARANCE_PX)
  })

  test('falls back BELOW when there is no room above', () => {
    const { top } = place({ y: 10 })
    expect(top).toBe(10 + CURSOR_CLEARANCE_PX)
  })

  test('the fallback still clears the cursor rather than sitting on it', () => {
    const y = 10
    const { top } = place({ y })
    expect(top - y).toBeGreaterThanOrEqual(CURSOR_CLEARANCE_PX)
  })

  test('flips down exactly at the boundary, not before', () => {
    // The highest hotspot that still fits above: y - H - clearance === pad.
    const yFits = EDGE_PAD_PX + H + CURSOR_CLEARANCE_PX
    expect(place({ y: yFits }).top).toBe(EDGE_PAD_PX)
    expect(place({ y: yFits - 1 }).top).toBe(yFits - 1 + CURSOR_CLEARANCE_PX)
  })

  test('never leaves the bottom edge', () => {
    const { top } = place({ y: VIEW.height - 5 })
    expect(top + H).toBeLessThanOrEqual(VIEW.height - EDGE_PAD_PX)
  })

  test('honours a custom clearance (large-cursor escape hatch, R3)', () => {
    const { top } = place({ y: 500, clearance: 64 })
    expect(top).toBe(500 - H - 64)
  })
})

describe('placeCursorTooltip — horizontal', () => {
  test('sits to the right of the hotspot by default', () => {
    expect(place({ x: 900 }).left).toBe(900 + CURSOR_OFFSET_X_PX)
  })

  test('flips to the left of the hotspot near the right edge', () => {
    const x = VIEW.width - 20
    expect(place({ x }).left).toBe(x - W - CURSOR_OFFSET_X_PX)
  })

  test('never leaves the right edge', () => {
    const { left } = place({ x: VIEW.width - 1 })
    expect(left + W).toBeLessThanOrEqual(VIEW.width - EDGE_PAD_PX)
  })

  test('never leaves the left edge', () => {
    const { left } = place({ x: 0 })
    expect(left).toBeGreaterThanOrEqual(EDGE_PAD_PX)
  })
})

describe('placeCursorTooltip — corners', () => {
  test('top-left: below and right, both inside bounds', () => {
    const { left, top } = place({ x: 0, y: 0 })
    expect(top).toBe(CURSOR_CLEARANCE_PX) // no room above -> below
    expect(left).toBeGreaterThanOrEqual(EDGE_PAD_PX)
  })

  test('top-right: below and flipped left', () => {
    const { left, top } = place({ x: VIEW.width, y: 0 })
    expect(top).toBe(CURSOR_CLEARANCE_PX)
    expect(left + W).toBeLessThanOrEqual(VIEW.width - EDGE_PAD_PX)
  })

  test('bottom-right: above and flipped left — the busiest real corner', () => {
    const x = VIEW.width - 4
    const y = VIEW.height - 4
    const { left, top } = place({ x, y })
    expect(top).toBe(y - H - CURSOR_CLEARANCE_PX)
    expect(left).toBe(x - W - CURSOR_OFFSET_X_PX)
  })

  test('bottom-left: above and to the right', () => {
    const y = VIEW.height - 4
    const { left, top } = place({ x: 0, y })
    expect(top).toBe(y - H - CURSOR_CLEARANCE_PX)
    expect(left).toBe(CURSOR_OFFSET_X_PX)
  })
})

describe('placeCursorTooltip — degenerate bounds', () => {
  test('a tooltip taller than the viewport clamps to the top pad instead of going negative', () => {
    const { top } = placeCursorTooltip({ x: 50, y: 50, w: W, h: 400, bounds: { width: 300, height: 200 } })
    expect(top).toBe(EDGE_PAD_PX)
  })

  test('a tooltip wider than the viewport clamps to the left pad instead of going negative', () => {
    const { left } = placeCursorTooltip({ x: 50, y: 50, w: 400, h: H, bounds: { width: 300, height: 200 } })
    expect(left).toBe(EDGE_PAD_PX)
  })

  test('zero-size bounds do not produce NaN or Infinity', () => {
    const { left, top } = placeCursorTooltip({ x: 0, y: 0, w: 0, h: 0, bounds: { width: 0, height: 0 } })
    expect(Number.isFinite(left)).toBe(true)
    expect(Number.isFinite(top)).toBe(true)
  })
})
