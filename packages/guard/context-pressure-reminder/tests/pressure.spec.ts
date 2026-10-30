import { describe, expect, it } from 'vitest'
import { formatTokenCount, renderReading, shouldPublish } from '@deepseek-ai/dsh-context-pressure-reminder/src/pressure.ts'
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
