import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as ContextPressureReminder from '@deepseek-ai/dsh-context-pressure-reminder'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Real-composition suite: the reading must survive the whole injection path —
 * `tools/post-execute` → `additionalContexts` → the loop's active-batch FIFO →
 * `agent/inbox/spliced` → the next step's `user/message` on the surface. The
 * meter is the REAL `dsh-token-meter`, not a stub, because the debounce reads
 * its actual measurement and a stubbed reading would prove nothing about the
 * path this plugin bets on.
 */

async function harness(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  // Order matters only for readability: the meter must exist before the guard
  // measures, and the guard looks it up per tool call.
  await ctx.plugin(TokenMeter, {})
  await ctx.plugin(ContextPressureReminder, { minDeltaRatio: 0 })
  ctx.tools.register(defineContentToolFixture({
    name: 'probe',
    description: 'p',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'ok' }] },
  }))
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

describe('real composition through token-meter', () => {
  it('lands the reading on the surface as a notice-form user message', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('compose-1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // 1. The reading left post-execute as a next-step inbox splice...
    const spliced = [...agent.session.events]
      .filter((e): e is SessionEvent<'agent/inbox/spliced'> => e.type === 'agent/inbox/spliced')
      .flatMap(e => e.data.inserted ?? [])
      .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
    expect(spliced.some(text => text.startsWith('[context: ~'))).toBe(true)

    // 2. ...and reached the surface as an ordinary append-form user message
    // with the plugin source intact, so a reader can tell it apart from a
    // human prompt.
    const onSurface = [...agent.session.events]
      .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message')
      .filter(e => e.data.source.kind === 'plugin' && e.data.source.plugin === 'context-pressure-reminder')
    expect(onSurface).toHaveLength(1)
    expect(onSurface[0]?.data.source).toMatchObject({ form: 'notice', summary: 'context pressure' })

    // 3. The reading is folded into derived history that the model receives.
    const derived = agent.session.deriveMessages()
    expect(derived.some(m => m.content.some(b => b.type === 'text' && b.text.startsWith('[context: ~')))).toBe(true)
  })

  it('publishes a real measurement rather than a zero when the meter has content', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('compose-2'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const reading = [...agent.session.events]
      .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message')
      .find(e => e.data.source.kind === 'plugin' && e.data.source.plugin === 'context-pressure-reminder')
    const text = reading?.data.content.map(b => b.type === 'text' ? b.text : '').join('') ?? ''
    // `[context: ~12.3k tokens]` or, below one thousand tokens, `[context: ~320 tokens]`.
    const match = /~([\d.]+)(k?) tokens/.exec(text)
    expect(match, `no reading in: ${text}`).not.toBeNull()
    const tokens = Number(match![1]) * (match![2] === 'k' ? 1000 : 1)
    // The surface already holds the task prompt and this tool's call/result, so
    // a real meter cannot report zero pressure.
    expect(tokens).toBeGreaterThan(0)
  })
})
