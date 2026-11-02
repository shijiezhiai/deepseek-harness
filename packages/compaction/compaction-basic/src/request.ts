/**
 * Log-derived facts a model-requested compaction needs: which compactions the
 * current turn has already produced, and whether the one waiting on the surface
 * came from the model or from automatic policy.
 *
 * The backend cannot remember this in fields without becoming replay-dependent,
 * so every number is folded from the durable log at the moment it is needed.
 *
 * @module @deepseek-ai/dsh-compaction-basic/request
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { COMPACT_TOOL_NAME } from '@deepseek-ai/dsh-tool-compact/request'

/** What one turn's log says about compaction origin. */
export interface TurnCompactionHistory {
  /** Compactions that opened during this turn, automatic and model-requested alike. */
  readonly compactions: number
  /** Compactions that answered a model request in this turn. */
  readonly servedRequests: number
}

/**
 * Fold one turn's compaction history from the log.
 *
 * A compaction counts as serving a model request when an unserved request call
 * precedes it in the same turn. Everything else — step pressure, overflow
 * recovery, a manual `/compact` that opened inside the turn — is automatic for
 * this purpose, which is what lets the caller tell "the model is asking again
 * after its request was served" apart from "the harness compacted on its own
 * before the model had read the result".
 *
 * @param session - session whose log is folded.
 * @param turn - turn the request belongs to.
 * @returns the turn's compaction counts.
 */
export function turnCompactionHistory(session: Session, turn: number): TurnCompactionHistory {
  let compactions = 0
  let servedRequests = 0
  let openRequest = false
  // Answering a request is order between a tool call and the compaction that
  // followed it, so the fold needs the turn's full sequence rather than one
  // projected value.
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  for (const event of session.snapshotEvents()) {
    if (event.type === 'tool/call') {
      if (event.data.turn === turn && event.data.name === COMPACT_TOOL_NAME && !openRequest) {
        openRequest = true
      }
      continue
    }
    if (event.type !== 'compaction/start' || event.data.turn !== turn) continue
    compactions += 1
    if (openRequest) {
      servedRequests += 1
      openRequest = false
    }
  }
  return { compactions, servedRequests }
}
