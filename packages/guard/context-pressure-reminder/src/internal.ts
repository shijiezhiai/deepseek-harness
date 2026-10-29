/**
 * Per-session bookkeeping for the context-pressure guard. Private to this
 * package: nothing here is model-visible or durable.
 *
 * @module @deepseek-ai/dsh-context-pressure-reminder/internal
 */

/** What the guard remembers about one session between steps. */
export interface SessionReadingState {
  /** Identity of the step that owns the most recent tool call. */
  step: { readonly turn: number; readonly step: number } | undefined
  /** `turn/step` key of the step already considered for a reading. */
  consideredStepKey: string | undefined
  /** Occupancy the last published reading reported. */
  publishedTokens: number | undefined
  /**
   * Surface sequence numbers of the most recent tool results, oldest first.
   * The nudge sizes its danger band from their prices, which it reads from the
   * measurement's nodes rather than by re-measuring each result.
   */
  recentToolSeqs: number[]
  /** Occupancy the last nudge announced while inside the band, else undefined. */
  announcedTokens: number | undefined
}

/**
 * Bound the retained observation list to the window the band actually reads.
 * @param seqs - surface sequence numbers of tool results, oldest first.
 * @param window - how many the band sizes itself from.
 * @returns the tail of `seqs` that can still influence the band.
 */
export function retainObservations(seqs: readonly number[], window: number): number[] {
  return seqs.length <= window ? [...seqs] : seqs.slice(-window)
}
