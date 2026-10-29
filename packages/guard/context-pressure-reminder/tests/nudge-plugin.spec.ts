import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ContextPressureReminder from '@deepseek-ai/dsh-context-pressure-reminder'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the pre-step nudge: the band gate, re-arming after the
 * session leaves the band, the delta-ratio repeat rule, `reject` pass-through,
 * independence from the post-execute reading, and load-time validation of the
 * band configuration. Every case drives a real agent loop against a scripted
 * mock adapter, so no network or API key is involved.
 */

/** Advertised capacity of the mock route. */
const WINDOW = 100_000

/**
 * Two tool calls and a closing answer — the shortest script that reaches a
 * third `agent/pre-step`.
 *
 * The measure order is fixed by the loop. Pre-step 1 runs before
 * `request/context` is logged, so it sees no window and never measures; from
 * then on every step measures twice, once from `tools/post-execute` (the
 * reading) and once from `agent/pre-step` (the nudge). A run therefore consumes
 * exactly four readings of the series: `[read(1), nudge(2), read(2), nudge(3)]`.
 */
const MEASURED_SCRIPT = [
  toolCallResponse('c1', 'probe', {}),
  toolCallResponse('c2', 'probe', {}),
  textResponse('done'),
]

/** A run with one tool call: two readings of the series. */
const SHORT_SCRIPT = [toolCallResponse('c1', 'probe', {}), textResponse('done')]

/**
 * A fresh copy of `script`. `MockAdapter` consumes its script with `shift()`, so
 * a shared module-level constant would leave every later test with no responses.
 * @param script - the scripted responses to copy.
 * @returns an independent array of the same responses.
 */
function replay(script: StreamChunk[][]): StreamChunk[][] {
  return [...script]
}

/**
 * Meter stand-in. `measure()` walks a scripted occupancy series and synthesizes
 * one surface node per tool result the session already logged, priced by
 * position from `toolPrices` (default 100).
 */
function meterStub(options: {
  readings: number[]
  toolPrices?: number[]
}): { measure(session: { events: readonly { type: string; seq: number }[] }): TokenMeasurement } {
  let index = 0
  return {
    measure(session): TokenMeasurement {
      const totalTokens = options.readings[Math.min(index, options.readings.length - 1)] ?? 0
      index += 1
      const toolSeqs = session.events.filter(event => event.type === 'tool/result').map(event => event.seq)
      return {
        totalTokens,
        nodes: toolSeqs.map((seq, position) => ({
          seq,
          tokens: options.toolPrices?.[position] ?? 100,
        })),
      } as TokenMeasurement
    },
  }
}

/** A mock adapter that also advertises `WINDOW`, so `requestContext()` publishes it. */
class WindowedAdapter extends MockAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: WINDOW } })
  }
}

interface HarnessResult {
  /** The booted context; every mounted service and listener unwinds with it. */
  ctx: Context
  /** Every `logger.warn` argument, in call order. */
  warns: string[]
}

/**
 * Boot the core spine, the guard, and a `probe` tool, plus a meter stand-in on
 * its own child fiber so the provided service and its script share a lifetime.
 * @param options - guard config, occupancy series, and per-result prices.
 * @returns the context and the captured warnings.
 */
async function harness(options: {
  config?: ContextPressureReminder.Config
  readings: number[]
  toolPrices?: number[]
  mountMeter?: boolean
}): Promise<HarnessResult> {
  const ctx = new Context()
  const warns: string[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ContextPressureReminder, options.config ?? {})
  ctx.tools.register(defineContentToolFixture({
    name: 'probe',
    description: 'probe the surface',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'ok' }] },
  }))
  if (options.mountMeter ?? true) {
    const meter = meterStub({ readings: options.readings, toolPrices: options.toolPrices })
    await ctx.plugin({
      name: 'token-meter-stub',
      apply(inner: Context) { inner.provide('tokenMeter', meter as never) },
    })
  }
  return { ctx, warns }
}

/**
 * Create one agent and wait for it to fall idle.
 * @param ctx - context holding the mounted llm runtime and loop.
 * @param script - responses to consume, in request order.
 * @param adapter - adapter to register; defaults to one advertising `WINDOW`.
 * @returns the settled agent.
 */
async function run(ctx: Context, script: StreamChunk[][], adapter = new WindowedAdapter(script)): Promise<Agent> {
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId(`n${Math.random().toString(36).slice(2)}`), {
    provider: 'mock',
    model: 'mock',
  })
  await settle(ctx, agent, 'go')
  return agent
}

/**
 * Send one user turn and wait for the agent to fall idle.
 * @param ctx - context observing agent status.
 * @param agent - the agent to drive.
 * @param text - the user prompt to append.
 */
async function settle(ctx: Context, agent: Agent, text: string): Promise<void> {
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
}

/** Every message this guard published, in log order. */
function published(agent: Agent): string[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'plugin')
    .map(e => e.data.content.map(block => block.type === 'text' ? block.text : '').join('|'))
}

/** The nudges among {@link published}. */
function nudges(agent: Agent): string[] {
  return published(agent).filter(text => text.includes('overshoot the window'))
}

/** The plain readings among {@link published}. */
function readings(agent: Agent): string[] {
  return published(agent).filter(text => text.startsWith('[context:') && !text.includes('overshoot the window'))
}

/**
 * The abbreviated total of each message, for terse series assertions.
 * @param found - rendered messages.
 * @returns the digits after the leading `~`, in order.
 */
function totals(found: string[]): (string | undefined)[] {
  return found.map(text => text.match(/~([\d.]+)/)?.[1])
}

describe('band gate', () => {
  it('stays silent while the headroom covers the band', async () => {
    // 50% occupancy leaves 50k of headroom against a 10k floor.
    const { ctx } = await harness({ readings: [50_000] })
    expect(nudges(await run(ctx, replay(MEASURED_SCRIPT)))).toEqual([])
  })

  it('nudges once the headroom is narrower than the floor band', async () => {
    const { ctx } = await harness({ readings: [0, 95_000, 95_000, 95_000] })
    expect(totals(nudges(await run(ctx, replay(MEASURED_SCRIPT))))).toEqual(['95.0'])
  })

  it('carries the occupancy, the percentage, and the headroom clause', async () => {
    const { ctx } = await harness({ readings: [0, 95_000, 95_000, 95_000] })
    const [nudge] = nudges(await run(ctx, replay(MEASURED_SCRIPT)))
    expect(nudge).toContain('~95.0k/100.0k tokens · 95%')
    expect(nudge).toContain('one more large tool result can overshoot the window')
  })

  it('repeats on the same step-boundary rule as a reading', async () => {
    // Two consecutive pre-steps at one occupancy nudge once, not twice.
    const { ctx } = await harness({ readings: [0, 95_000, 95_000, 95_000] })
    expect(nudges(await run(ctx, replay(MEASURED_SCRIPT)))).toHaveLength(1)
  })

  it('never nudges when the route advertises no window', async () => {
    const { ctx } = await harness({ readings: [99_999] })
    const agent = await run(ctx, replay(MEASURED_SCRIPT), new MockAdapter(replay(MEASURED_SCRIPT)))
    expect(nudges(agent)).toEqual([])
  })
})

describe('delta-ratio repeat', () => {
  it('holds the repeat while the occupancy moves under minDeltaRatio', async () => {
    // 95.0k then 95.5k: a 0.5% move, below the 2% default.
    const { ctx } = await harness({ readings: [0, 95_000, 95_000, 95_500] })
    expect(totals(nudges(await run(ctx, replay(MEASURED_SCRIPT))))).toEqual(['95.0'])
  })

  it('repeats once the occupancy moves by minDeltaRatio', async () => {
    // 95.0k then 98.0k: a 3% move, above the 2% default.
    const { ctx } = await harness({ readings: [0, 95_000, 95_000, 98_000] })
    expect(totals(nudges(await run(ctx, replay(MEASURED_SCRIPT))))).toEqual(['95.0', '98.0'])
  })

  it('repeats on the smallest move when minDeltaRatio is zero', async () => {
    const { ctx } = await harness({ config: { minDeltaRatio: 0 }, readings: [0, 95_000, 95_000, 95_500] })
    expect(totals(nudges(await run(ctx, replay(MEASURED_SCRIPT))))).toEqual(['95.0', '95.5'])
  })
})

describe('re-arm', () => {
  it('re-arms after the session leaves the band and fires again on the way back', async () => {
    // Nudge at 95%, fall to 60% (out of band), return to 95% next turn.
    const { ctx } = await harness({ readings: [0, 95_000, 95_000, 60_000, 95_000] })
    const agent = await run(ctx, [...replay(MEASURED_SCRIPT), textResponse('second')])
    await settle(ctx, agent, 'again')
    expect(totals(nudges(agent))).toEqual(['95.0', '95.0'])
  })

  it('stays silent after leaving the band while it stays out', async () => {
    const { ctx } = await harness({ readings: [0, 95_000, 95_000, 60_000, 60_000] })
    const agent = await run(ctx, [...replay(MEASURED_SCRIPT), textResponse('second')])
    await settle(ctx, agent, 'again')
    expect(totals(nudges(agent))).toEqual(['95.0'])
  })
})

describe('observation-sized band', () => {
  it('leaves the band at the floor when recent results are small', async () => {
    // 100-token results keep the band at the 10k floor, so 60% is far outside it.
    const { ctx } = await harness({ readings: [0, 60_000, 60_000, 60_000] })
    expect(nudges(await run(ctx, replay(MEASURED_SCRIPT)))).toEqual([])
  })

  it('widens the band for a recent wide tool result', async () => {
    // The first result is priced at 40% of the window: doubled it clears the 10k
    // floor and reaches the 50k cap, so 60% occupancy is already inside the band.
    const { ctx } = await harness({ readings: [0, 20_000, 60_000, 60_000], toolPrices: [40_000, 100] })
    expect(totals(nudges(await run(ctx, replay(MEASURED_SCRIPT))))).toEqual(['60.0'])
  })
})

describe('ordering against other listeners', () => {
  it('keeps a later-registered pre-step message ahead of the nudge', async () => {
    const { ctx } = await harness({ readings: [0, 95_000, 95_000, 95_000] })
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text: 'downstream-context' }],
            source: { kind: 'plugin', plugin: 'downstream' },
          }),
        ],
      }
    })
    const order = published(await run(ctx, replay(MEASURED_SCRIPT)))
    const downstream = order.findIndex(text => text.includes('downstream-context'))
    const nudge = order.findIndex(text => text.includes('overshoot the window'))
    expect(downstream).toBeGreaterThanOrEqual(0)
    // The nudge measures the request that survived every downstream listener, so
    // it lands last.
    expect(nudge).toBeGreaterThan(downstream)
  })

  it('never appends a message to a rejected step', async () => {
    const { ctx } = await harness({ readings: [0, 95_000, 95_000, 95_000] })
    ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
    expect(nudges(await run(ctx, replay(SHORT_SCRIPT)))).toEqual([])
  })

  it('delegates to a later listener instead of short-circuiting it', async () => {
    const { ctx } = await harness({ readings: [0, 95_000, 95_000, 95_000] })
    let seen = 0
    ctx.on('agent/pre-step', async () => {
      seen += 1
      return { kind: 'enter', messages: [] }
    })
    await run(ctx, replay(MEASURED_SCRIPT))
    expect(seen).toBeGreaterThan(0)
  })

  it('keeps readings and nudges on separate schedules', async () => {
    // The same four measurements yield two readings (post-execute) and one
    // nudge, and the nudge never replaces the reading it shares a step with.
    const { ctx } = await harness({ readings: [0, 95_000, 95_000, 95_000] })
    const agent = await run(ctx, replay(MEASURED_SCRIPT))
    expect(totals(readings(agent))).toEqual(['0', '95.0'])
    expect(totals(nudges(agent))).toEqual(['95.0'])
    expect(nudges(agent)[0]).not.toEqual(readings(agent)[1])
  })
})

describe('configuration and mounting', () => {
  it('publishes no nudge when nudge.enabled is false but keeps readings', async () => {
    const { ctx } = await harness({
      config: { nudge: { enabled: false } },
      readings: [0, 95_000, 95_000, 95_000],
    })
    const agent = await run(ctx, replay(MEASURED_SCRIPT))
    expect(totals(readings(agent))).toEqual(['0', '95.0'])
    expect(nudges(agent)).toEqual([])
  })

  it('warns once and nudges nothing when no token meter is mounted', async () => {
    const { ctx, warns } = await harness({ readings: [0, 95_000, 95_000, 95_000], mountMeter: false })
    expect(nudges(await run(ctx, replay(MEASURED_SCRIPT)))).toEqual([])
    expect(warns.filter(warning => warning.includes('no token meter mounted'))).toHaveLength(1)
  })

  it('widens the band with a raised floor', async () => {
    // 75% occupancy leaves 25k of headroom: outside the 10k default, inside a 30k floor.
    const atDefault = await harness({ readings: [0, 75_000, 75_000, 75_000] })
    expect(nudges(await run(atDefault.ctx, replay(MEASURED_SCRIPT)))).toEqual([])
    const raised = await harness({
      config: { nudge: { minBandRatio: 0.3 } },
      readings: [0, 75_000, 75_000, 75_000],
    })
    expect(totals(nudges(await run(raised.ctx, replay(MEASURED_SCRIPT))))).toEqual(['75.0'])
  })

  it('narrows the band with a lower ceiling', async () => {
    // A 40k result doubles to 80k, which the default 50k ceiling caps; a 15k
    // ceiling caps it further, leaving 60% occupancy outside the band.
    const capped = await harness({ readings: [0, 60_000, 60_000, 60_000], toolPrices: [40_000, 100] })
    expect(totals(nudges(await run(capped.ctx, replay(MEASURED_SCRIPT))))).toEqual(['60.0'])
    const lowered = await harness({
      config: { nudge: { maxBandRatio: 0.15 } },
      readings: [0, 60_000, 60_000, 60_000],
      toolPrices: [40_000, 100],
    })
    expect(nudges(await run(lowered.ctx, replay(MEASURED_SCRIPT)))).toEqual([])
  })

  it('rejects an inverted band range', async () => {
    await expect(harness({
      config: { nudge: { minBandRatio: 0.6, maxBandRatio: 0.2 } },
      readings: [0],
    })).rejects.toThrow(/exceeds nudge.maxBandRatio/)
  })

  it('rejects a band ratio outside (0, 1]', async () => {
    await expect(harness({ config: { nudge: { minBandRatio: 0 } }, readings: [0] }))
      .rejects.toThrow(/must be in \(0, 1\]/)
    await expect(harness({ config: { nudge: { maxBandRatio: 1.5 } }, readings: [0] }))
      .rejects.toThrow(/must be in \(0, 1\]/)
  })

  it('rejects a non-integer observation window', async () => {
    await expect(harness({ config: { nudge: { observationWindow: 1.5 } }, readings: [0] }))
      .rejects.toThrow(/observationWindow/)
  })

  it('rejects a negative observation multiplier', async () => {
    await expect(harness({ config: { nudge: { observationMultiplier: -1 } }, readings: [0] }))
      .rejects.toThrow(/observationMultiplier/)
  })
})
