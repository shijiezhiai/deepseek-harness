/**
 * Behavior suite for the danger band, the nudge emit rule, and the nudge
 * wording — pure functions, no harness.
 */

import { describe, expect, it } from 'vitest'
import { dangerNeed, renderNudge, shouldNudge } from '@deepseek-ai/dsh-context-pressure-reminder/src/nudge.ts'
import type { DangerBandConfig, NudgeInput } from '@deepseek-ai/dsh-context-pressure-reminder/src/nudge.ts'
import type { ReadingFormat } from '@deepseek-ai/dsh-context-pressure-reminder/src/pressure.ts'

const BAND: DangerBandConfig = {
  observationMultiplier: 2,
  minBandRatio: 0.1,
  maxBandRatio: 0.5,
  observationWindow: 3,
}
const WINDOW = 100_000
const FORMAT: ReadingFormat = { precision: 1, unit: 'k' }

describe('dangerNeed sizing', () => {
  it('falls back to the floor when no result has been observed', () => {
    // 10% of the window: the ordinary "last tenth" rule.
    expect(dangerNeed(WINDOW, [], BAND)).toBe(10_000)
  })

  it('collapses to the floor while results are small', () => {
    // 2 x 200 is far below the 10% floor.
    expect(dangerNeed(WINDOW, [200, 150, 80], BAND)).toBe(10_000)
  })

  it('sizes from the largest retained observation when it exceeds the floor', () => {
    // 2 x 8_000, above the 10_000 floor? No — 16_000 is above it.
    expect(dangerNeed(WINDOW, [8_000, 200, 80], BAND)).toBe(16_000)
  })

  it('reads only the retention window', () => {
    // The 40_000 result has fallen out of the 3-deep window; 2 x 1_000 is below the floor.
    expect(dangerNeed(WINDOW, [40_000, 1_000, 200, 80], BAND)).toBe(10_000)
  })

  it('keeps an observation that is inside the retention window', () => {
    // 40_000 is the third-newest of three retained results, so it still sizes the band.
    expect(dangerNeed(WINDOW, [1_000, 200, 40_000], BAND)).toBe(50_000)
  })

  it('sizes from the whole recent set, not just the newest result', () => {
    // A session that just read a small file is still at risk from the wide one before it.
    expect(dangerNeed(WINDOW, [8_000, 80], BAND)).toBe(16_000)
  })

  it('caps one enormous observation at the max band ratio', () => {
    // 2 x 90_000 would be 180_000; the cap keeps it at half the window.
    expect(dangerNeed(WINDOW, [90_000], BAND)).toBe(50_000)
  })

  it('never falls below the floor even with a zero multiplier', () => {
    expect(dangerNeed(WINDOW, [50_000], { ...BAND, observationMultiplier: 0 })).toBe(10_000)
  })

  it('keeps the floor above a raised ceiling', () => {
    // Misconfiguration fails loud at load, so this pair cannot reach `dangerNeed`
    // through the plugin; the arithmetic still refuses an inverted range.
    expect(dangerNeed(WINDOW, [90_000], { ...BAND, minBandRatio: 0.8, maxBandRatio: 0.2 })).toBe(80_000)
  })
})

/** One nudge decision with the band already resolved. */
function decision(overrides: Partial<NudgeInput> = {}): boolean {
  return shouldNudge({
    totalTokens: 95_000,
    contextWindow: WINDOW,
    need: 10_000,
    announcedTokens: undefined,
    minDeltaRatio: 0.02,
    ...overrides,
  })
}

describe('shouldNudge', () => {
  it('never nudges without an advertised window', () => {
    expect(decision({ contextWindow: 0 })).toBe(false)
    expect(decision({ contextWindow: -1 })).toBe(false)
  })

  it('stays silent while the headroom still covers the band', () => {
    // 89_000 leaves 11_000 of headroom against a 10_000 band.
    expect(decision({ totalTokens: 89_000 })).toBe(false)
  })

  it('fires the first time the headroom drops inside the band', () => {
    expect(decision({ totalTokens: 91_000 })).toBe(true)
  })

  it('fires exactly at the band edge', () => {
    // Headroom equals the band; "narrower than one more result" starts here.
    expect(decision({ totalTokens: 90_000 })).toBe(false)
    expect(decision({ totalTokens: 90_001 })).toBe(true)
  })

  it('holds a repeat below the delta ratio', () => {
    // 1% since the announcement, under the 2% default.
    expect(decision({ totalTokens: 93_000, announcedTokens: 92_000 })).toBe(false)
  })

  it('repeats once the delta ratio is met', () => {
    expect(decision({ totalTokens: 94_000, announcedTokens: 92_000 })).toBe(true)
  })

  it('treats a drop as worth repeating', () => {
    // A drop inside the band still changes the picture; the rule compares magnitudes.
    expect(decision({ totalTokens: 90_500, announcedTokens: 94_000 })).toBe(true)
  })

  it('repeats on every step when the delta ratio is zero', () => {
    expect(decision({ totalTokens: 95_000, announcedTokens: 95_000, minDeltaRatio: 0 })).toBe(true)
  })

  it('holds a step that already announced the same occupancy', () => {
    expect(decision({ totalTokens: 95_000, announcedTokens: 95_000 })).toBe(false)
  })

  it('fires at zero occupancy when the band covers the whole window', () => {
    // A window narrower than the band: every step is already inside it.
    expect(decision({ totalTokens: 0, contextWindow: 8_000, need: 10_000 })).toBe(true)
  })
})

describe('renderNudge', () => {
  it('carries the occupancy, the percentage, and the headroom clause', () => {
    expect(renderNudge({ totalTokens: 86_100, contextWindow: 128_000, format: FORMAT })).toBe(
      '[context: ~86.1k/128.0k tokens · 67% — one more large tool result can overshoot the window;'
      + ' prefer finishing a unit of work and writing findings to a file]',
    )
  })

  it('never suggests compacting, which the model cannot do', () => {
    const text = renderNudge({ totalTokens: 120_000, contextWindow: 128_000, format: FORMAT })
    expect(text).not.toMatch(/compact/i)
  })

  it('honors the raw unit', () => {
    expect(renderNudge({ totalTokens: 86_100, contextWindow: 128_000, format: { precision: 0, unit: 'raw' } }))
      .toContain('~86100/128000 tokens')
  })

  it('keeps small windows in integer form', () => {
    expect(renderNudge({ totalTokens: 900, contextWindow: 1_000, format: FORMAT }))
      .toContain('~900/1.0k tokens · 90%')
  })

  it('rounds the percentage to the nearest whole point', () => {
    expect(renderNudge({ totalTokens: 1_250, contextWindow: 1_000, format: FORMAT })).toContain('· 125%')
  })
})
