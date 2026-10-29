import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ContextPressureReminder from '@deepseek-ai/dsh-context-pressure-reminder'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the context-pressure guard: one reading per step, the
 * minDeltaRatio debounce, fold-onto-downstream-decision (both variants),
 * per-session isolation, the missing-meter warn, and fail-loud config
 * validation — driven through a real agent loop against a scripted mock
 * adapter (no network).
 */

/** Two tool calls requested in ONE assistant message (a single step). */
function multiCall(calls: { id: string; name: string; args: object }[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  calls.forEach((call, index) => {
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: JSON.stringify(call.args) } },
    )
  })
  chunks.push(
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

/**
 * Meter stand-in: the guard only calls `measure()`. Each call advances through
 * the scripted series, repeating the last value once it is exhausted so a
 * single stub serves any number of readings.
 */
function meterStub(readings: number[]): { measure(): TokenMeasurement } {
  let index = 0
  return {
    measure(): TokenMeasurement {
      const totalTokens = readings[Math.min(index, readings.length - 1)] ?? 0
      index += 1
      return { totalTokens } as TokenMeasurement
    },
  }
}

interface HarnessResult {
  ctx: Context
  /** Every `logger.warn` argument, in call order. */
  warns: string[]
}

/**
 * Boot the core spine plus the guard. The meter stand-in is provided on a
 * child context so the service registration and its `measure()` script share
 * one fiber; `mountMeter: false` leaves no `tokenMeter` in the tree at all.
 */
async function harness(options: {
  config?: ContextPressureReminder.Config
  readings?: number[]
  mountMeter?: boolean
} = {}): Promise<HarnessResult> {
  const ctx = new Context()
  const warns: string[] = []
  const mountMeter = options.mountMeter ?? true
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ContextPressureReminder, options.config ?? {})
  ctx.tools.register(defineContentToolFixture({
    name: 'probe',
    description: 'p',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'ok' }] },
  }))
  if (mountMeter) {
    const meter = meterStub(options.readings ?? [10_000])
    await ctx.plugin({
      name: 'token-meter-stub',
      apply(inner: Context) { inner.provide('tokenMeter', meter as never) },
    })
  }
  return { ctx, warns }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** Every injected-context message in the log, flattened to its joined text. */
function notices(agent: Agent): string[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind !== 'user')
    .map(e => e.data.content.map(block => block.type === 'text' ? block.text : '').join('|'))
}

/** Drive one fresh agent through the scripted responses and return its notices. */
async function run(ctx: Context, script: StreamChunk[][]): Promise<{ agent: Agent; notices: string[] }> {
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId(`a${Math.random().toString(36).slice(2)}`), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  return { agent, notices: notices(agent) }
}

/** The abbreviated count from each reading, for terse series assertions. */
function counts(found: string[]): (string | undefined)[] {
  return found.map(text => text.match(/~([\d.]+)/)?.[1])
}

describe('one reading per step', () => {
  it('publishes one reading per tool step', async () => {
    const { ctx } = await harness({ readings: [10_000, 20_000, 30_000] })
    const { notices: found } = await run(ctx, [
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      textResponse('done'),
    ])
    // Each reading lands in the NEXT step's inbox, so two tool steps yield two.
    expect(counts(found)).toEqual(['10.0', '20.0'])
  })

  it('publishes at most one reading for parallel calls in one step', async () => {
    const { ctx } = await harness({ readings: [10_000, 20_000] })
    const { notices: found } = await run(ctx, [
      multiCall([{ id: 'c1', name: 'probe', args: {} }, { id: 'c2', name: 'probe', args: {} }]),
      textResponse('done'),
    ])
    expect(found).toHaveLength(1)
  })

  it('publishes nothing for a turn with no tool call', async () => {
    const { ctx } = await harness({ readings: [10_000] })
    const { notices: found } = await run(ctx, [textResponse('done')])
    expect(found).toEqual([])
  })
})

describe('minDeltaRatio debounce', () => {
  it('measures each step against the last PUBLISHED reading, not the last step', async () => {
    // 10_000 → 10_100 (1%, suppressed) → 10_250 (2.5% vs 10_000, published;
    // one decimal digit rounds 10.25 up to 10.3).
    const { ctx } = await harness({ readings: [10_000, 10_100, 10_250] })
    const { notices: found } = await run(ctx, [
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      toolCallResponse('c3', 'probe', {}),
      textResponse('done'),
    ])
    expect(counts(found)).toEqual(['10.0', '10.3'])
  })

  it('publishes every step when minDeltaRatio is zero', async () => {
    const { ctx } = await harness({ config: { minDeltaRatio: 0 }, readings: [10_000, 10_000, 10_000] })
    const { notices: found } = await run(ctx, [
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      textResponse('done'),
    ])
    expect(found).toHaveLength(2)
  })

  it('publishes a large change even when the ratio is the default', async () => {
    const { ctx } = await harness({ readings: [10_000, 40_000] })
    const { notices: found } = await run(ctx, [
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      textResponse('done'),
    ])
    expect(counts(found)).toEqual(['10.0', '40.0'])
  })
})

describe('rendering', () => {
  it('omits the percentage when the route publishes no context window', async () => {
    const { ctx } = await harness({ readings: [48_200] })
    const { notices: found } = await run(ctx, [toolCallResponse('c1', 'probe', {}), textResponse('done')])
    expect(found).toEqual(['[context: ~48.2k tokens]'])
  })

  it('honors the raw unit and precision from config', async () => {
    const { ctx } = await harness({ config: { unit: 'raw', precision: 0 }, readings: [48_200] })
    const { notices: found } = await run(ctx, [toolCallResponse('c1', 'probe', {}), textResponse('done')])
    expect(found).toEqual(['[context: ~48200 tokens]'])
  })
})

describe('fold onto downstream decisions', () => {
  it('carries the reading alongside a downstream block', async () => {
    const { ctx } = await harness({ readings: [10_000] })
    ctx.on('tools/post-execute', async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'not now' }] }))
    const { notices: found } = await run(ctx, [toolCallResponse('c1', 'probe', {}), textResponse('done')])
    expect(found).toEqual(['[context: ~10.0k tokens]'])
  })

  it('places its reading before a downstream accept decision, whose contexts survive', async () => {
    const { ctx } = await harness({ readings: [10_000] })
    const extra = createUserMessage({
      content: [{ type: 'text', text: 'later' }],
      source: { kind: 'plugin', plugin: 'downstream' },
    })
    ctx.on('tools/post-execute', async () => ({
      kind: 'accept',
      content: [{ type: 'text', text: 'ok' }],
      additionalContexts: [extra],
    }) as never)
    const { notices: found } = await run(ctx, [toolCallResponse('c1', 'probe', {}), textResponse('done')])
    expect(found).toEqual(['[context: ~10.0k tokens]', 'later'])
  })
})

describe('turn-concluding results', () => {
  it('publishes nothing after a tool that concludes the turn', async () => {
    // A concluding result ends the turn at its step. Stray next-step work
    // reopens that boundary and bills another model request, so the reading
    // must yield to the conclusion.
    const { ctx } = await harness({ readings: [10_000] })
    ctx.tools.register(defineContentToolFixture({
      name: 'finish',
      description: 'f',
      parameters: {},
      async execute(_args, exec) {
        exec.concludeTurn()
        return [{ type: 'text', text: 'done' }]
      },
    }))
    const { notices: found } = await run(ctx, [toolCallResponse('c1', 'finish', {})])
    expect(found).toEqual([])
  })

  it('keeps a reading submitted before a later sibling concludes the turn', async () => {
    // Results commit in model order, so this reading was already in the
    // next-step inbox when the concluding sibling committed. The turn
    // conclusion deliberately does not retract submitted next-step work; only
    // the concluding result's OWN reading is withheld.
    const { ctx } = await harness({ readings: [10_000] })
    ctx.tools.register(defineContentToolFixture({
      name: 'finish',
      description: 'f',
      parameters: {},
      async execute(_args, exec) {
        exec.concludeTurn()
        return [{ type: 'text', text: 'done' }]
      },
    }))
    const { notices: found } = await run(ctx, [
      multiCall([{ id: 'c1', name: 'probe', args: {} }, { id: 'c2', name: 'finish', args: {} }]),
    ])
    // One reading — from `probe`. The concluding `finish` adds none of its own.
    expect(counts(found)).toEqual(['10.0'])
  })
})

describe('per-session isolation', () => {
  it('gives each session its own debounce baseline', async () => {
    // One context, one adapter, two sessions created side by side.
    const { ctx } = await harness({ readings: [10_000] })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}), textResponse('done'),
      toolCallResponse('c2', 'probe', {}), textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const first = ctx.agentLoop.create(SessionId('s1'), { provider: 'mock', model: 'mock' })
    const second = ctx.agentLoop.create(SessionId('s2'), { provider: 'mock', model: 'mock' })
    first.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, first)
    second.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, second)
    // The second session's first reading publishes on its own merits even
    // though the shared meter reports the same value.
    expect(notices(first)).toHaveLength(1)
    expect(notices(second)).toHaveLength(1)
  })
})

describe('missing meter', () => {
  it('warns once and publishes nothing when no token meter is mounted', async () => {
    const { ctx, warns } = await harness({ mountMeter: false })
    const { notices: found } = await run(ctx, [toolCallResponse('c1', 'probe', {}), textResponse('done')])
    expect(found).toEqual([])
    expect(warns.filter(w => w.includes('no token meter mounted'))).toHaveLength(1)
  })
})

describe('fail-loud config', () => {
  it('rejects a negative precision', async () => {
    await expect(harness({ config: { precision: -1 } })).rejects.toThrow(/invalid precision/)
  })

  it('rejects a non-integer precision', async () => {
    await expect(harness({ config: { precision: 1.5 } })).rejects.toThrow(/invalid precision/)
  })

  it('rejects a negative minDeltaRatio', async () => {
    await expect(harness({ config: { minDeltaRatio: -0.1 } })).rejects.toThrow(/invalid minDeltaRatio/)
  })
})

describe('disabled', () => {
  it('publishes nothing when enabled is false', async () => {
    const { ctx } = await harness({ config: { enabled: false }, readings: [10_000] })
    const { notices: found } = await run(ctx, [toolCallResponse('c1', 'probe', {}), textResponse('done')])
    expect(found).toEqual([])
  })
})
