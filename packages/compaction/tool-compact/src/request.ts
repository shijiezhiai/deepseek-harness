/**
 * The model-facing compaction request vocabulary, and the log fold that answers
 * "does the log carry a request nothing has answered yet".
 *
 * A tool cannot compact inline: `compactNow` reserves an idle agent, while a
 * tool body always runs inside the agent's `running` phase. The request must
 * therefore travel through the durable log. The tool call itself IS the request
 * — the model calls the tool, the event commits, and the compaction backend
 * claims it at the next `agent/pre-step`, where the agent is between steps and a
 * replacement can be committed.
 *
 * That makes this module a pure fold over `SessionEvent`s: no Cordis context, no
 * clock, no mutable state. Serving the request is the backend's job; this module
 * only says which request is waiting and what the model asked the summary to
 * preserve.
 *
 * @module @deepseek-ai/dsh-tool-compact/request
 */

import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: makes the compaction vocabulary (and `compaction/start`) part of
// the SessionEventMap this fold switches on.
import type {} from '@deepseek-ai/dsh-compaction'

/** The stable model-facing tool name whose call requests one compaction. */
export const COMPACT_TOOL_NAME = 'compact_context'

/**
 * Plugin name that answers requests. An answer — served or declined — is
 * recognised by a notice the answering backend appended, so the fold needs the
 * name rather than a private marker the backend would have to invent.
 */
export const COMPACT_ANSWER_KIND = 'compaction-basic'

/** One pending model request, derived from the log. */
export interface CompactionRequest {
  /** Seq of the `tool/call` event that carried the request. */
  readonly requestSeq: number
  /** Turn the requesting call ran in. */
  readonly turn: number
  /** The model's optional statement of what the summary must preserve. */
  readonly focus?: string
}

/**
 * Read the optional `focus` argument from a logged call's JSON argument text.
 *
 * A malformed argument string is the tool registry's rejection to make, not this
 * fold's: the registry has already validated the call before it logged one, so
 * this reads no focus rather than inventing a second validation authority.
 */
function readFocus(argumentsJson: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const focus = (parsed as { focus?: unknown }).focus
  return typeof focus === 'string' && focus.trim().length > 0 ? focus.trim() : undefined
}

/** Whether this event is the answering backend's notice to the model. */
function isAnswerNotice(event: { type: string; data: unknown }): boolean {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: { kind?: string } }).source
  return source?.kind === COMPACT_ANSWER_KIND
}

/**
 * Derive the oldest request the log still carries unanswered.
 *
 * One request per turn: once a request has been answered — by a compaction
 * transaction or by the backend's refusal notice — a later call in the same turn
 * is the model repeating itself, and the first call still describes the surface
 * the backend would compact.
 *
 * A `turn/start` retires a request as well. A request belongs to the turn that
 * made it; a turn whose surface has since been replaced describes a surface that
 * is no longer in front of the model, so serving it later would compact history
 * the model never saw.
 *
 * @param session - session whose log is folded.
 * @returns the pending request, or undefined when none is pending.
 */
export function pendingCompactionRequest(session: Session): CompactionRequest | undefined {
  let pending: CompactionRequest | undefined
  let answeredThisTurn = false
  // Whether a request is still pending depends on which tool calls and
  // compactions came before it, so the fold reads the sequence.
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  for (const event of session.snapshotEvents()) {
    switch (event.type) {
      case 'tool/call': {
        if (event.data.name !== COMPACT_TOOL_NAME) break
        if (pending !== undefined || answeredThisTurn) break
        const focus = readFocus(event.data.arguments)
        pending = {
          requestSeq: event.seq,
          turn: event.data.turn,
          ...focus === undefined ? {} : { focus },
        }
        break
      }
      case 'compaction/start':
        // Any transaction that opens after a request answers it, whichever
        // policy asked for it: automatic pressure, overflow recovery, or the
        // request itself.
        if (pending !== undefined) {
          pending = undefined
          answeredThisTurn = true
        }
        break
      case 'user/message':
        // The backend's own notice — a refusal or a completion — answers the
        // request just as a transaction does. Without this the refusal would be
        // repeated on every following pre-step of the same turn.
        if (pending !== undefined && isAnswerNotice(event)) {
          pending = undefined
          answeredThisTurn = true
        }
        break
      case 'turn/start':
        pending = undefined
        answeredThisTurn = false
        break
      default:
        break
    }
  }
  return pending
}
