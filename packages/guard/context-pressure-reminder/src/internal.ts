/**
 * Per-session bookkeeping for the context-pressure guard. Private to this
 * package: nothing here is model-visible or durable.
 *
 * @module @deepseek-ai/dsh-context-pressure-reminder/internal
 */

/** What the guard remembers about one session between tool calls. */
export interface SessionReadingState {
  /** Identity of the step that owns the most recent tool call. */
  step: { readonly turn: number; readonly step: number } | undefined
  /** `turn/step` key of the step already considered for a reading. */
  consideredStepKey: string | undefined
  /** Occupancy the last published reading reported. */
  publishedTokens: number | undefined
}
