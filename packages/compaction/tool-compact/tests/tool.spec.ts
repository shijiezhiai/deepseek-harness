/**
 * The `compact_context` tool as the model sees it: registered under a stable
 * name, schema-shaped for one optional `focus`, and answering with an
 * acknowledgement that promises nothing already done.
 *
 * Driven through a real `ToolRuntime` and a real `Session`, so the registered
 * schema and the executed result are the shipping code rather than a stand-in.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { COMPACT_TOOL_NAME } from '../src/request.ts'
import * as tool from '../src/index.ts'

const SIGNAL = new AbortController().signal

/**
 * A real Agent over a real Session, because `tools.execute` takes the live
 * object and the suite should not fabricate one. The loop stays unmounted: no
 * step runs, so the call needs the agent itself and nothing above it.
 */
async function agentWithSession(id = 'compact-request'): Promise<Agent> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: 'test-provider', model: 'test-model' },
  })
  return handle.agent
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(tool)
  return ctx
}

let counter = 0
async function call(ctx: Context, args: unknown, agent?: Agent) {
  const batch = await ctx.tools.execute({
    signal: SIGNAL,
    calls: [{
      type: 'tool-call',
      id: ToolCallId(`compact-${++counter}`),
      name: COMPACT_TOOL_NAME,
      arguments: JSON.stringify(args),
    }],
    agent: agent ?? await agentWithSession(),
  })
  return batch.results[0]!.result
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('dsh-tool-compact', () => {
  it('registers one tool named compact_context', async () => {
    const ctx = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([COMPACT_TOOL_NAME])
  })

  it('takes exactly one optional string argument', async () => {
    const ctx = await setup()
    const schema = ctx.tools.get(COMPACT_TOOL_NAME)
    const props = (schema!.parameters as { properties?: Record<string, { type: string }> }).properties ?? {}
    expect(Object.keys(props)).toEqual(['focus'])
    expect(props.focus!.type).toBe('string')
    expect((schema!.parameters as { required?: string[] }).required).toBeUndefined()
  })

  it('describes itself as a request that runs before the next step', async () => {
    const ctx = await setup()
    const description = ctx.tools.schemas()
      .find(candidate => candidate.name === COMPACT_TOOL_NAME)!.description
    // The model must not believe the compaction already happened when it reads
    // this result, so the description says when it runs.
    expect(description).toContain('before your next step')
    expect(description).toContain('records the request')
  })

  it('acknowledges the request without claiming a compaction ran', async () => {
    const ctx = await setup()
    const result = await call(ctx, {})
    expect(textOf(result)).toContain('Compaction requested')
    expect(textOf(result)).not.toContain('finished')
  })

  it('returns the requested discriminator as its output value', async () => {
    const ctx = await setup()
    const result = await call(ctx, { focus: 'the retry policy' })
    expect(result.value).toEqual({ kind: 'requested' })
  })

  it('appends nothing to the log, because the call itself is the request', async () => {
    const ctx = await setup()
    const agent = await agentWithSession()
    await call(ctx, { focus: 'anything' }, agent)
    // The backend reads the `tool/call` this execution came from. A tool that
    // also appended its own event would need an invariant and a format member.
    expect(agent.session.snapshotEvents()).toHaveLength(0)
  })


  it('presents the request as a generic call card carrying the focus', async () => {
    const ctx = await setup()
    const schema = ctx.tools.get(COMPACT_TOOL_NAME)
    const presentation = schema!.presentCall?.({ focus: 'the retry policy' })
    expect(presentation?.card).toBe('generic')
    if (presentation?.card !== 'generic') throw new Error('expected a generic call card')
    expect(presentation.title).toBe('Request compaction')
    expect(presentation.rawInput).toEqual({ focus: 'the retry policy' })
  })

  it('presents a bare request with no focus as empty input', async () => {
    const ctx = await setup()
    const schema = ctx.tools.get(COMPACT_TOOL_NAME)
    const presentation = schema!.presentCall?.({})
    if (presentation?.card !== 'generic') throw new Error('expected a generic call card')
    expect(presentation.rawInput).toEqual({})
  })
})
