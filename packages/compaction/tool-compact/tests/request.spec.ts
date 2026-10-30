/**
 * Request fold: which pending `compact_context` call the backend should answer,
 * and which one it must consider already answered.
 *
 * The fold is the whole idempotence story. If it reports a request that was
 * already answered, the model is told the same refusal on every following step;
 * if it forgets one that is still waiting, the model was promised a compaction
 * nothing performed.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { COMPACT_TOOL_NAME, pendingCompactionRequest } from '../src/request.ts'

let serial = 0

/** One session whose log this test appends to directly. */
function fresh(): Session {
  serial += 1
  return Session.create(SessionId(`request-fold-${serial}`))
}

/** Append a turn opener for `turn`. */
function turn(session: Session, value: number): void {
  session.append('turn/start', { turn: value })
}

/** Append a model call to the request tool. */
function request(session: Session, value: number, focus?: string): number {
  const argumentsJson = focus === undefined ? '{}' : JSON.stringify({ focus })
  return session.append('tool/call', {
    turn: value,
    step: 1,
    callId: ToolCallId(`call-${serial}-${session.seq}`),
    name: COMPACT_TOOL_NAME,
    arguments: argumentsJson,
  }).seq
}

/** Append the backend's answer notice, the way the backend does. */
function answer(session: Session, plugin = 'compaction-basic'): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Compaction not started: fixture.' }],
    // A kind this package does not declare: the fold must fall through it.
    source: { kind: plugin, form: 'notice', summary: 'compaction declined' } as MessageSource,
  }), { surfaceOp: 'append' })
}

/** Append a compaction transaction opener. */
function compactionStarts(session: Session, value: number): void {
  session.append('compaction/start', { compactionId: `c-${session.seq}` as never, turn: value })
}

describe('pendingCompactionRequest', () => {
  it('reports nothing on a log with no request', () => {
    const session = fresh()
    turn(session, 1)
    expect(pendingCompactionRequest(session)).toBeUndefined()
  })

  it('reports the call that carried the request, with its turn and focus', () => {
    const session = fresh()
    turn(session, 1)
    const seq = request(session, 1, 'the parsing decision')
    expect(pendingCompactionRequest(session)).toEqual({
      requestSeq: seq,
      turn: 1,
      focus: 'the parsing decision',
    })
  })

  it('omits focus when the model gave none', () => {
    const session = fresh()
    turn(session, 1)
    request(session, 1)
    expect(pendingCompactionRequest(session)).not.toHaveProperty('focus')
  })

  it('ignores focus that is empty or whitespace', () => {
    const session = fresh()
    turn(session, 1)
    request(session, 1, '   ')
    expect(pendingCompactionRequest(session)).not.toHaveProperty('focus')
  })

  it('treats a compaction transaction as the answer', () => {
    const session = fresh()
    turn(session, 1)
    request(session, 1)
    compactionStarts(session, 1)
    expect(pendingCompactionRequest(session)).toBeUndefined()
  })

  it('treats the backend notice as the answer, so a refusal is not repeated', () => {
    const session = fresh()
    turn(session, 1)
    request(session, 1)
    answer(session)
    // This is the regression that matters: without it the model reads the same
    // refusal on every following pre-step of the turn.
    expect(pendingCompactionRequest(session)).toBeUndefined()
  })

  it('does not treat an unrelated plugin notice as the answer', () => {
    const session = fresh()
    turn(session, 1)
    request(session, 1)
    answer(session, 'context-pressure-reminder')
    expect(pendingCompactionRequest(session)?.turn).toBe(1)
  })

  it('does not treat an ordinary user message as the answer', () => {
    const session = fresh()
    turn(session, 1)
    request(session, 1)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'carry on' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(pendingCompactionRequest(session)?.turn).toBe(1)
  })

  it('answers a repeated request only once per turn', () => {
    const session = fresh()
    turn(session, 1)
    const first = request(session, 1)
    request(session, 1)
    // The second call is the model repeating itself; the first call still
    // describes the surface the backend would compact.
    expect(pendingCompactionRequest(session)?.requestSeq).toBe(first)
  })

  it('does not re-open a request in a turn whose answer already landed', () => {
    const session = fresh()
    turn(session, 1)
    request(session, 1)
    answer(session)
    request(session, 1)
    expect(pendingCompactionRequest(session)).toBeUndefined()
  })

  it('lets the next turn request again', () => {
    const session = fresh()
    turn(session, 1)
    request(session, 1)
    answer(session)
    turn(session, 2)
    const second = request(session, 2)
    expect(pendingCompactionRequest(session)).toEqual({ requestSeq: second, turn: 2 })
  })

  it('retires a request the turn ended without answering', () => {
    const session = fresh()
    turn(session, 1)
    request(session, 1)
    // A turn that ended unserved described a surface that is no longer in front
    // of the model, so serving it in the next turn would compact unseen history.
    turn(session, 2)
    expect(pendingCompactionRequest(session)).toBeUndefined()
  })

  it('ignores calls to other tools', () => {
    const session = fresh()
    turn(session, 1)
    session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('other'), name: 'read', arguments: '{}',
    })
    expect(pendingCompactionRequest(session)).toBeUndefined()
  })

  it('reads no focus from arguments the registry would have rejected', () => {
    const session = fresh()
    turn(session, 1)
    session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('broken'), name: COMPACT_TOOL_NAME, arguments: '{not json',
    })
    const pending = pendingCompactionRequest(session)
    expect(pending).toBeDefined()
    expect(pending).not.toHaveProperty('focus')
  })
})
