/**
 * The backend half of a model-initiated compaction: the `agent/pre-step` branch
 * that claims a `compact_context` call, gates it, and answers it exactly once.
 *
 * Every case drives the real loop, so what is asserted is what the model reads
 * in its next request, not what a stub returned.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmResolvedModelInfo, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { COMPACT_TOOL_NAME } from '@deepseek-ai/dsh-tool-compact'
import * as toolCompact from '@deepseek-ai/dsh-tool-compact'

const MODEL = 'mock'
const PROMPT = 'older conversation history '.repeat(60)
// The seeded prose is small next to a 100k window, so occupancy is measured in
// single digits; a floor near zero is what lets the serve path run at all.
const LOW_FLOOR = { minContextRatio: 0.001 }

/** A summarizer under test control, recording every call it receives. */
class RecordingEngine extends BasicCompactionEngine {
  calls: SummarizationInput[] = []

  override summarize(
    input: SummarizationInput,
    _agent: Agent,
    _signal?: AbortSignal,
  ): Promise<SummaryResult> {
    this.calls.push(input)
    return Promise.resolve({
      summary: [{ type: 'text', text: 'checkpoint' }] as ContentBlock[],
      provider: 'summary-provider',
      model: 'summary-model',
    })
  }
}

/**
 * One scripted answer per request. A script entry of `'compact'` answers with the
 * `compact_context` call; `'text'` answers with prose and ends the turn.
 */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: Message[][] = []
  script: ('text' | 'compact')[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 100_000 },
    })
  }

  override async * stream(options: { messages: readonly Message[] }): AsyncIterable<StreamChunk> {
    this.requests.push([...options.messages])
    const next = this.script.shift() ?? 'text'
    if (next === 'compact') {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: ToolCallId(`compact-${this.requests.length}`),
          name: COMPACT_TOOL_NAME,
          arguments: '{}',
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly engine: RecordingEngine
  readonly adapter: ScriptedAdapter
}

let serial = 0

async function harness(
  requestPolicy?: { minContextRatio?: number; maxPerTurn?: number },
  serveRequests = true,
  pressure = false,
): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(toolCompact)
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter([MODEL], adapter)
  const engine = new RecordingEngine(ctx, {
    // `auto` gates the step-boundary listener as a whole, and that listener also
    // owns the request branch. Pressure itself stays off below the threshold.
    auto: true,
    serveRequests,
    // Pressure off by default: a seeded conversation is far below the window, so
    // only a deliberately tiny threshold would make the automatic path fire.
    ...pressure ? { thresholdRatio: 0.001, retainRatio: 0.0005 } : {},
    ...requestPolicy === undefined ? {} : { requestPolicy },
  })
  const agent = ctx.agentLoop.create(SessionId(`request-${++serial}`), {
    provider: MODEL,
    model: MODEL,
  })
  return { ctx, agent, engine, adapter }
}

/** Give the session a closed span worth compacting. */
async function seed(loop: Harness, script: ('text' | 'compact')[] = ['text']): Promise<void> {
  loop.adapter.script.push(...script)
  loop.agent.followup(createUserMessage({
    content: [{ type: 'text', text: PROMPT }],
    source: { kind: 'user' },
  }))
  await loop.agent.whenIdle()
}

/** Text blocks of every derived model-visible message, in request order. */
function derivedText(session: Session): string[] {
  return session.deriveMessages().map((message: Message) => message.content
    .map(block => block.type === 'text' ? block.text : '')
    .join(''))
}

/** Every text the model was shown across all requests, oldest first. */
function seenText(loop: Harness): string[] {
  return loop.adapter.requests.flatMap(request => request.map(message => message.content
    .map(block => block.type === 'text' ? block.text : '')
    .join('')))
}


/** Attach one reading to every tool result, the way a post-execute guard does. */
async function mountReadingPlugin(ctx: Context): Promise<void> {
  await ctx.plugin({
    name: 'reading-plugin',
    apply: (inner: Context) => {
      inner.on('tools/post-execute', async (_exec, _result, next) => {
        const decision = await next()
        const reading = createUserMessage({
          content: [{ type: 'text', text: '[context: ~8.3k/20.0k tokens \u00b7 41%]' }],
          source: { kind: 'plugin', plugin: 'context-pressure-reminder', form: 'notice', summary: 'context pressure' },
        })
        return { ...decision, additionalContexts: [...decision.additionalContexts ?? [], reading] }
      })
    },
  })
}

describe('a model compaction request', () => {
  it('compacts before the next step and reports what it folded', async () => {
    const loop = await harness(LOW_FLOOR)
    await seed(loop)
    loop.adapter.script.push('compact', 'text')
    loop.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'tidy up' }],
      source: { kind: 'user' },
    }))
    await loop.agent.whenIdle()

    expect(loop.engine.calls).toHaveLength(1)
    expect(loop.agent.session.events.some(event => event.type === 'compaction/start')).toBe(true)
    expect(seenText(loop).some(text => text.startsWith('Compaction finished:'))).toBe(true)
  })

  it('answers a declined request exactly once, not on every following step', async () => {
    // A fresh conversation has almost nothing behind it, so the occupancy floor
    // refuses the request — and the refusal must not be repeated.
    const loop = await harness()
    loop.adapter.script.push('compact', 'text')
    loop.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'tidy up' }],
      source: { kind: 'user' },
    }))
    await loop.agent.whenIdle()

    const refusals = seenText(loop).filter(text => text.startsWith('Compaction not started:'))
    expect(refusals).toHaveLength(1)
    expect(loop.engine.calls).toHaveLength(0)
  })

  it('does not replace a surface the harness already compacted this turn', async () => {
    // Turn 1 compacts under pressure with nobody asking. The model then reads the
    // checkpoint and, before its next step, asks for a compaction anyway. That
    // second compaction would fold a checkpoint the model has just been shown and
    // has not yet acted on, so the request is declined instead.
    const loop = await harness(LOW_FLOOR, true, true)
    await seed(loop, ['text'])
    loop.adapter.script.push('compact', 'text')
    loop.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'tidy up' }],
      source: { kind: 'user' },
    }))
    await loop.agent.whenIdle()

    const starts = loop.agent.session.events.filter(event => event.type === 'compaction/start')
    // The automatic one is the only compaction: the summarizer ran once.
    expect(starts).toHaveLength(1)
    expect(loop.engine.calls).toHaveLength(1)
    expect(seenText(loop).some(text => text.includes('Compaction finished:'))).toBe(true)
  })

  it('keeps the messages the loop already claimed for the step', async () => {
    // The reading a plugin attaches to a tool result lands on next-step AFTER
    // the step returns, so it is pending exactly when the compaction request is
    // served at the following step boundary. `claim()` has already taken it off
    // the inbox by then, so a decision carrying only this listener's notice
    // would drop it silently.
    const loop = await harness(LOW_FLOOR)
    await mountReadingPlugin(loop.ctx)
    await seed(loop)
    loop.adapter.script.push('compact', 'text')
    loop.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'tidy up' }],
      source: { kind: 'user' },
    }))
    await loop.agent.whenIdle()

    expect(seenText(loop).some(text => text.includes('41%'))).toBe(true)
    expect(seenText(loop).some(text => text.startsWith('Compaction finished:'))).toBe(true)
  })

  it('declines the request once the per-turn limit is spent', async () => {
    const loop = await harness({ minContextRatio: 0.001, maxPerTurn: 1 })
    await seed(loop)
    loop.adapter.script.push('compact', 'text')
    loop.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'tidy up' }],
      source: { kind: 'user' },
    }))
    await loop.agent.whenIdle()

    expect(loop.engine.calls).toHaveLength(1)
    expect(seenText(loop).some(text => text.startsWith('Compaction finished:'))).toBe(true)
  })

  it('leaves requests entirely alone when the deployment switches serving off', async () => {
    const loop = await harness(undefined, false)
    await seed(loop)
    loop.adapter.script.push('compact', 'text')
    loop.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'tidy up' }],
      source: { kind: 'user' },
    }))
    await loop.agent.whenIdle()

    // The tool still acknowledges; the backend simply never performs it, and the
    // model is not told anything it did not derive from the tool result.
    expect(loop.engine.calls).toHaveLength(0)
    expect(seenText(loop).some(text => text.startsWith('Compaction not started:'))).toBe(false)
  })

  it('is not triggered by an ordinary turn that never asks', async () => {
    const loop = await harness()
    await seed(loop)
    loop.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await loop.agent.whenIdle()
    expect(loop.engine.calls).toHaveLength(0)
    expect(loop.agent.session.events.some(event => event.type === 'compaction/start')).toBe(false)
    expect(derivedText(loop.agent.session)).not.toContain(expect.stringContaining('Compaction not started'))
  })
})
