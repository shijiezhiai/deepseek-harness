import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_TURNS_IN_READING,
  formatTokenCount,
  renderReading,
  shouldPublish,
  turnSizes,
} from '@deepseek-ai/dsh-context-pressure-reminder/src/pressure.ts'
import type { ReadingFormat } from '@deepseek-ai/dsh-context-pressure-reminder/src/pressure.ts'

/**
 * Pure-layer suite for the context-pressure reading: count formatting, the
 * reading line in each window-known/unknown form, and the debounce decision.
 */

const k1: ReadingFormat = { precision: 1, unit: 'k' }

describe('formatTokenCount', () => {
  it('abbreviates thousands with the configured precision', () => {
    expect(formatTokenCount(48_200, k1)).toBe('48.2k')
    expect(formatTokenCount(128_000, k1)).toBe('128.0k')
  })

  it('keeps the integer form below one thousand so early readings never read as 0.xk', () => {
    expect(formatTokenCount(320, k1)).toBe('320')
    expect(formatTokenCount(999, k1)).toBe('999')
    expect(formatTokenCount(1000, k1)).toBe('1.0k')
  })

  it('honors precision 0 and the raw unit', () => {
    expect(formatTokenCount(48_200, { precision: 0, unit: 'k' })).toBe('48k')
    expect(formatTokenCount(48_200, { precision: 3, unit: 'k' })).toBe('48.200k')
    expect(formatTokenCount(48_200, { precision: 1, unit: 'raw' })).toBe('48200')
  })

  it('clamps a negative count to zero rather than printing a negative size', () => {
    expect(formatTokenCount(-5, k1)).toBe('0')
  })
})

describe('renderReading', () => {
  it('prints the absolute count and a percentage when the route publishes a window', () => {
    expect(renderReading({ totalTokens: 48_200, contextWindow: 128_000, format: k1 }))
      .toBe('[context: ~48.2k/128.0k tokens · 38%]')
  })

  it('rounds the percentage to a whole number', () => {
    expect(renderReading({ totalTokens: 112_000, contextWindow: 128_000, format: k1 }))
      .toBe('[context: ~112.0k/128.0k tokens · 88%]')
  })

  it('omits the percentage when the route publishes no window', () => {
    expect(renderReading({ totalTokens: 48_200, format: k1 }))
      .toBe('[context: ~48.2k tokens]')
  })

  it('treats a non-positive window as unknown instead of dividing by zero', () => {
    expect(renderReading({ totalTokens: 48_200, contextWindow: 0, format: k1 }))
      .toBe('[context: ~48.2k tokens]')
  })
})

describe('shouldPublish', () => {
  it('always publishes the first reading of a session', () => {
    expect(shouldPublish(undefined, 10, 0.02)).toBe(true)
    expect(shouldPublish(undefined, 0, 0.5)).toBe(true)
  })

  it('suppresses a change below the ratio and publishes one at or above it', () => {
    // 2% of 10_000 is 200.
    expect(shouldPublish(10_000, 10_150, 0.02)).toBe(false)
    expect(shouldPublish(10_000, 10_200, 0.02)).toBe(true)
    expect(shouldPublish(10_000, 10_400, 0.02)).toBe(true)
  })

  it('treats a drop as interesting as a rise', () => {
    // 2% of 10_000 is 200, in either direction.
    expect(shouldPublish(10_000, 9_850, 0.02)).toBe(false)
    expect(shouldPublish(10_000, 9_800, 0.02)).toBe(true)
    expect(shouldPublish(10_000, 9_700, 0.02)).toBe(true)
  })

  it('publishes every step when the ratio is zero', () => {
    expect(shouldPublish(10_000, 10_000, 0)).toBe(true)
  })

  it('treats a zero baseline as one token so the ratio stays finite', () => {
    expect(shouldPublish(0, 0, 0.02)).toBe(false)
    expect(shouldPublish(0, 1, 0.02)).toBe(true)
  })
})

describe('renderReading per-turn split', () => {
  const threeTurns = [
    { turn: 1, tokens: 10_800 },
    { turn: 2, tokens: 31_400 },
    { turn: 3, tokens: 400 },
  ] as const

  it('appends every turn ascending when they all fit', () => {
    expect(renderReading({ totalTokens: 48_200, contextWindow: 128_000, format: k1, turns: threeTurns }))
      .toBe('[context: ~48.2k/128.0k tokens · 38% · turns 1-3: 10.8k 31.4k 400]')
  })

  it('appends the split to the window-less form too', () => {
    expect(renderReading({ totalTokens: 48_200, format: k1, turns: threeTurns }))
      .toBe('[context: ~48.2k tokens · turns 1-3: 10.8k 31.4k 400]')
  })

  it('prints nothing for a single turn, where the sizes would restate the total', () => {
    const one = [{ turn: 1, tokens: 48_200 }] as const
    expect(renderReading({ totalTokens: 48_200, contextWindow: 128_000, format: k1, turns: one }))
      .toBe('[context: ~48.2k/128.0k tokens · 38%]')
  })

  it('prints nothing when the caller supplies no split', () => {
    expect(renderReading({ totalTokens: 48_200, format: k1, turns: [] }))
      .toBe('[context: ~48.2k tokens]')
  })

  it('keeps the newest turns and folds the rest into one additive earlier figure', () => {
    // The three printed numbers plus `earlier` account for the whole 48.2k.
    expect(renderReading({ totalTokens: 48_200, format: k1, turns: threeTurns, maxTurns: 2 }))
      .toBe('[context: ~48.2k tokens · earlier turn 1: 10.8k · turns 2-3: 31.4k 400]')
  })

  it('labels a single folded turn as a turn rather than a range', () => {
    const five = [
      { turn: 1, tokens: 1_000 },
      { turn: 2, tokens: 2_000 },
      { turn: 3, tokens: 3_000 },
      { turn: 4, tokens: 4_000 },
      { turn: 5, tokens: 5_000 },
    ] as const
    expect(renderReading({ totalTokens: 15_000, format: k1, turns: five, maxTurns: 4 }))
      .toBe('[context: ~15.0k tokens · earlier turn 1: 1.0k · turns 2-5: 2.0k 3.0k 4.0k 5.0k]')
  })

  it('honors maxTurns 0 as no split at all', () => {
    expect(renderReading({ totalTokens: 48_200, format: k1, turns: threeTurns, maxTurns: 0 }))
      .toBe('[context: ~48.2k tokens]')
  })

  it('renders turn sizes with the same unit as the total', () => {
    expect(renderReading({ totalTokens: 48_200, format: { precision: 1, unit: 'raw' }, turns: threeTurns }))
      .toBe('[context: ~48200 tokens · turns 1-3: 10800 31400 400]')
  })

  it('defaults the cap to the exported default', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ turn: index + 1, tokens: 100 }))
    const rendered = renderReading({ totalTokens: 1_200, format: k1, turns: many })
    const newest = Array.from({ length: DEFAULT_MAX_TURNS_IN_READING }, () => '100').join(' ')
    expect(rendered).toBe(`[context: ~1.2k tokens · earlier turns 1-4: 400 · turns 5-12: ${newest}]`)
  })
})

describe('turnSizes', () => {
  const starts = [
    { turn: 1, seq: 10 },
    { turn: 2, seq: 20 },
    { turn: 3, seq: 30 },
  ]

  it('sums each node into the newest turn started at or before it', () => {
    const nodes = [
      { seq: 10, tokens: 100 },
      { seq: 12, tokens: 200 },
      { seq: 20, tokens: 300 },
      { seq: 31, tokens: 400 },
    ]
    expect(turnSizes(nodes, starts)).toEqual([
      { turn: 1, tokens: 300 },
      { turn: 2, tokens: 300 },
      { turn: 3, tokens: 400 },
    ])
  })

  it('drops a turn whose nodes were all shadowed by compaction', () => {
    const nodes = [
      { seq: 10, tokens: 100 },
      { seq: 30, tokens: 400 },
    ]
    expect(turnSizes(nodes, starts)).toEqual([
      { turn: 1, tokens: 100 },
      { turn: 3, tokens: 400 },
    ])
  })

  it('uses each node sequence, not array position, so a spliced checkpoint lands in its own turn', () => {
    // A compaction checkpoint keeps a high sequence number but sits at the
    // start of the surface array; position-based splitting would misfile it
    // into turn 1, while its sequence places it in the turn that ran the
    // compaction.
    const nodes = [
      { seq: 40, tokens: 5_000 },
      { seq: 12, tokens: 200 },
      { seq: 31, tokens: 400 },
    ]
    expect(turnSizes(nodes, starts)).toEqual([
      { turn: 1, tokens: 200 },
      { turn: 3, tokens: 5_400 },
    ])
  })

  it('ignores nodes that precede the first recorded turn start', () => {
    const nodes = [
      { seq: 1, tokens: 999 },
      { seq: 10, tokens: 100 },
    ]
    expect(turnSizes(nodes, starts)).toEqual([{ turn: 1, tokens: 100 }])
  })

  it('returns nothing when no turn start was observed', () => {
    expect(turnSizes([{ seq: 10, tokens: 100 }], [])).toEqual([])
  })
})
