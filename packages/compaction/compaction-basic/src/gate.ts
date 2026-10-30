/**
 * Policy for serving a model-requested compaction.
 *
 * These decisions are what a model cannot make for itself: whether compacting
 * now would discard working state it still needs, and whether it is asking again
 * before the previous answer could have helped. The mechanism gates — a summary
 * that does not shrink its range, and a surface that changes during
 * summarization — already live in the transaction that commits the replacement
 * and apply to a requested compaction exactly as they apply to an automatic one.
 *
 * No Cordis context, no session, no clock: every input is a plain value, so the
 * model-facing text and every boundary are unit-testable without a harness.
 *
 * @module @deepseek-ai/dsh-compaction-basic/gate
 */

/** Deployment policy for serving a model-requested compaction. */
export interface RequestGateConfig {
  /**
   * Lowest occupancy, as a fraction of the window, at which a request is served.
   * Below it the summary would replace history the model still needs, so the
   * request is declined and the model keeps working.
   */
  readonly minContextRatio: number
  /** Model-served compactions per turn, so a model cannot compact in a loop. */
  readonly maxPerTurn: number
}

/** Why a request was declined. */
export type RequestRefusal =
  /** Occupancy is too low to have anything worth discarding. */
  | 'too-early'
  /** This turn already reached `maxPerTurn`. */
  | 'turn-limit'
  /** No finished span of the conversation can be folded into a summary. */
  | 'nothing-to-compact'
  /** No provider/model is durably routed, so no summary can be requested. */
  | 'unroutable'

/** One gate evaluation. */
export interface RequestGateInput {
  /** Route-priced estimated total of the next request. */
  readonly totalTokens: number
  /** Adapter-advertised capacity; absent when the route publishes none. */
  readonly contextWindow?: number | undefined
  /** Model-served compactions that already committed in this turn. */
  readonly servedThisTurn: number
  /** Policy limits. */
  readonly config: RequestGateConfig
}

/** The gate's answer for one request. */
export type RequestGateDecision =
  | { readonly kind: 'serve' }
  | { readonly kind: 'refuse'; readonly reason: RequestRefusal }

/**
 * Decide whether one model request may be served, before any range is selected.
 *
 * The per-turn limit is checked first because it is the answer that needs no
 * measurement, and a route that publishes no window must still be protected from
 * a compacting loop. A route with no published window is never judged
 * `too-early`: there is no basis for saying the context is nearly empty, and
 * guessing would refuse work the model has a reason to do.
 *
 * Whether a compactable span exists is deliberately NOT part of this decision:
 * that needs a measured surface, so the caller reports it as
 * `nothing-to-compact` after selection, keeping this function free of session
 * vocabulary.
 *
 * @param input - occupancy, per-turn count, and policy.
 * @returns whether the request is served and, when not, why.
 */
export function evaluateRequestGate(input: RequestGateInput): RequestGateDecision {
  if (input.servedThisTurn >= input.config.maxPerTurn) {
    return { kind: 'refuse', reason: 'turn-limit' }
  }
  const window = input.contextWindow
  if (window !== undefined && window > 0) {
    const floor = input.config.minContextRatio * window
    if (input.totalTokens < floor) return { kind: 'refuse', reason: 'too-early' }
  }
  return { kind: 'serve' }
}

/**
 * Render the model-facing refusal.
 *
 * Every wording keeps three commitments: it says the request was understood, it
 * says nothing was compacted, and — except for the loop limit — it says what the
 * model can do instead. The loop limit proposes nothing, because the model is
 * already doing the thing it should stop doing.
 *
 * @param reason - why the gate declined.
 * @param input - occupancy and policy, for the numbers the text cites.
 * @returns the one-paragraph refusal.
 */
export function renderRefusal(reason: RequestRefusal, input: RequestGateInput): string {
  switch (reason) {
    case 'too-early': {
      const window = input.contextWindow ?? 0
      const percent = Math.round((input.totalTokens / window) * 100)
      return `Compaction not started: the context is at ~${percent}% of the window, below the `
        + `${Math.round(input.config.minContextRatio * 100)}% floor. Compacting now would discard `
        + 'work you still need. Keep going, and request compaction once the context is closer to full.'
    }
    case 'turn-limit':
      return 'Compaction not started: this turn has already compacted '
        + `${input.servedThisTurn} time(s), the configured limit. Continue the work with the `
        + 'context you have.'
    case 'nothing-to-compact':
      return 'Compaction not started: there is no finished stretch of this conversation to '
        + 'fold into a summary yet. Continue the work, and request compaction once earlier '
        + 'turns hold detail you no longer need.'
    case 'unroutable':
      return 'Compaction not started: no provider and model are routed yet, so there is '
        + 'nothing to summarize with. Continue the work.'
    /* v8 ignore next 2 -- RequestRefusal is closed and every member is handled above */
    default: return assertNever(reason)
  }
}

/** Fail loudly rather than return an empty refusal for an unhandled reason. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new TypeError(`unknown compaction refusal reason: ${String(value)}`)
}
/* v8 ignore stop */
