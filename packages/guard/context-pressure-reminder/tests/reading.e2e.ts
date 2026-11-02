import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { provideWorkingDirectoryFixture, mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as ContextPressureReminder from '@deepseek-ai/dsh-context-pressure-reminder'

let ctx: Context | undefined
let workdir: string | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

async function harness(): Promise<{ ctx: Context; agent: Agent }> {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-context-pressure-e2e-'))
  ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { personaPrefix: 'Answer the user exactly and concisely.' },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(ContextPressureReminder)
  await ctx.plugin(LlmDeepSeek, { models: [{ id: 'deepseek-v4-flash' }] })
  const handle = await ctx.agents.create({
    sessionId: SessionId('context-pressure-e2e-session'),
    meta: { cwd: workdir },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })
  return { ctx, agent: handle.agent }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function readings(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== 'user/message' || event.data.source?.kind !== 'context-pressure-reminder') return []
    return event.data.content.flatMap(block => (block.type === 'text' ? [block.text] : []))
  })
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('context pressure e2e: the real route decision selects the reading', () => {
  it('renders the occupancy against the window the adapter advertised', async () => {
    const live = await harness()

    live.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Reply with the single word: ready' }], source: { kind: 'user' } }))
    await waitForIdle(live.ctx, live.agent)

    const session = live.agent.session
    const window = session.requestContext()?.contextWindow
    expect(window).toBeDefined()
    const [reading] = readings(session.snapshotEvents())
    // The adapter owes a capacity for the route it served; a reading without the
    // percentage means `request/context` reached the session without one.
    expect(reading).toMatch(/^\[context: ~[\d.]+k\/[\d.]+k tokens · \d+%\]$/u)
    expect(reading).not.toBe('[context: ~0 tokens]')
  }, 120_000)
})
