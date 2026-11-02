/**
 * Gate policy: the boundaries a model request must clear before the backend
 * spends a summarization on it.
 */

import { describe, expect, it } from 'vitest'
import { evaluateRequestGate, renderRefusal } from '../src/gate.ts'
import type { RequestGateInput, RequestRefusal } from '../src/gate.ts'

const POLICY = { minContextRatio: 0.1, maxPerTurn: 2 }

function gate(over: Partial<RequestGateInput> = {}): RequestGateInput {
  return { totalTokens: 50_000, contextWindow: 100_000, servedThisTurn: 0, config: POLICY, ...over }
}

describe('evaluateRequestGate', () => {
  it('serves a request that clears every boundary', () => {
    expect(evaluateRequestGate(gate())).toEqual({ kind: 'serve' })
  })

  it('serves at exactly the occupancy floor', () => {
    // 10% of 100_000 = 10_000. The floor is inclusive: a request that reaches
    // it has enough context behind it to be worth folding.
    expect(evaluateRequestGate(gate({ totalTokens: 10_000 }))).toEqual({ kind: 'serve' })
  })

  it('declines one token below the floor', () => {
    expect(evaluateRequestGate(gate({ totalTokens: 9_999 })))
      .toEqual({ kind: 'refuse', reason: 'too-early' })
  })

  it('serves at the per-turn limit minus one and declines at the limit', () => {
    expect(evaluateRequestGate(gate({ servedThisTurn: 1 }))).toEqual({ kind: 'serve' })
    expect(evaluateRequestGate(gate({ servedThisTurn: 2 })))
      .toEqual({ kind: 'refuse', reason: 'turn-limit' })
  })

  it('never judges occupancy on a route that publishes no window', () => {
    // No window means no basis for calling the context nearly empty; guessing
    // would refuse work the model has a reason to do.
    expect(evaluateRequestGate(gate({ contextWindow: undefined, totalTokens: 5 })))
      .toEqual({ kind: 'serve' })
    expect(evaluateRequestGate(gate({ contextWindow: 0, totalTokens: 5 })))
      .toEqual({ kind: 'serve' })
  })

  it('checks the per-turn limit before occupancy', () => {
    // Both boundaries are violated; the answer must be the one that does not
    // depend on a measurement, so the model is told about its own looping.
    expect(evaluateRequestGate(gate({ servedThisTurn: 5, totalTokens: 1 })))
      .toEqual({ kind: 'refuse', reason: 'turn-limit' })
  })

  it('serves when the per-turn limit is zero only if nothing was served', () => {
    const disabled = { ...gate({ config: { minContextRatio: 0, maxPerTurn: 0 } }) }
    expect(evaluateRequestGate(disabled)).toEqual({ kind: 'refuse', reason: 'turn-limit' })
  })
})

describe('renderRefusal', () => {
  const reasons: readonly RequestRefusal[] = ['too-early', 'turn-limit', 'nothing-to-compact', 'unroutable']

  it('opens every wording with the same claim, that nothing ran', () => {
    for (const reason of reasons) {
      expect(renderRefusal(reason, gate())).toMatch(/^Compaction not started: /)
    }
  })

  it('cites the measured occupancy and the configured floor', () => {
    const text = renderRefusal('too-early', gate({ totalTokens: 4_000 }))
    expect(text).toContain('~4% of the window')
    expect(text).toContain('10% floor')
  })

  it('cites the served count for a loop limit', () => {
    expect(renderRefusal('turn-limit', gate({ servedThisTurn: 2 }))).toContain('2 time(s)')
  })

  it('offers no next action for a loop limit, because the model is already repeating itself', () => {
    const text = renderRefusal('turn-limit', gate({ servedThisTurn: 2 }))
    expect(text).not.toMatch(/request compaction once/)
    expect(text).toContain('Continue the work')
  })

  it('offers a next action where one exists', () => {
    expect(renderRefusal('nothing-to-compact', gate())).toContain('request compaction once earlier')
    expect(renderRefusal('too-early', gate({ totalTokens: 4_000 }))).toContain('request compaction once')
  })

  it('names the missing route rather than asking the model to retry', () => {
    expect(renderRefusal('unroutable', gate())).toContain('no provider and model are routed')
  })

  it('renders nothing for a window it cannot divide by without inventing a number', () => {
    // 0/0 is the only reachable division: a window of 0 was never a window, so
    // the gate already skipped the check and this wording is unreachable from
    // `evaluateRequestGate`. It must still not render "NaN".
    const text = renderRefusal('too-early', gate({ contextWindow: 0, totalTokens: 5 }))
    expect(text).not.toContain('NaN')
  })
})
