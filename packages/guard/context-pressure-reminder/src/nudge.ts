/**
 * Pure danger-band arithmetic, wording, and emit decision for the guard's
 * context nudge. No Cordis context, no session, no clock: every input is a plain
 * value, so the band and the emit rule are unit-testable without a harness.
 *
 * The band exists because automatic compaction is checked once per step, before
 * the request. A single wide tool result can carry the context from below the
 * band straight past the window within one step, so a fixed fraction of the
 * window would warn too late to be useful. Sizing the band from the largest
 * recent observation keeps the warning ahead of that jump.
 *
 * @module @deepseek-ai/dsh-context-pressure-reminder/nudge
 */

import { formatTokenCount } from './pressure.ts'
import type { ReadingFormat } from './pressure.ts'
import { shouldPublish } from './pressure.ts'

/** How the band is sized from the window and the recent observations. */
export interface DangerBandConfig {
  /** Multiplier applied to the largest retained observation. */
  readonly observationMultiplier: number
  /** Lower bound on the band, as a fraction of the context window. */
  readonly minBandRatio: number
  /** Upper bound on the band, as a fraction of the context window. */
  readonly maxBandRatio: number
  /** How many recent observations the band is sized from. */
  readonly observationWindow: number
}

/**
 * Width of the headroom below the context window in which the nudge fires.
 *
 * Sizing from observations keeps the warning ahead of a wide result: when a
 * recent result is wider than a fixed band, the context would cross the band and
 * the window in the same step. Small results collapse the multiplier term and
 * leave the `minBandRatio` floor, which is the ordinary "last tenth" rule.
 * `maxBandRatio` stops one enormous result from nagging through half the window.
 *
 * @param contextWindow - adapter-advertised capacity in tokens.
 * @param observations - recent tool-result token counts, oldest first.
 * @param config - band sizing.
 * @returns headroom in tokens; the nudge fires while remaining headroom is
 *   below it.
 */
export function dangerNeed(
  contextWindow: number,
  observations: readonly number[],
  config: DangerBandConfig,
): number {
  const recent = observations.slice(-config.observationWindow)
  const largest = recent.length === 0 ? 0 : Math.max(...recent)
  const byObservation = config.observationMultiplier * largest
  const cap = config.maxBandRatio * contextWindow
  return Math.max(config.minBandRatio * contextWindow, Math.min(byObservation, cap))
}

/** One nudge decision input. */
export interface NudgeInput {
  /** Route-priced estimated total of the next request. */
  readonly totalTokens: number
  /** Adapter-advertised capacity; the nudge never fires without one. */
  readonly contextWindow: number
  /** Band width from {@link dangerNeed}. */
  readonly need: number
  /** Occupancy the last nudge announced, or undefined when the model is outside the band. */
  readonly announcedTokens: number | undefined
  /** Smallest relative change worth repeating a nudge for. */
  readonly minDeltaRatio: number
}

/**
 * Decide whether this step's request deserves a nudge.
 *
 * A route that publishes no window cannot be reasoned about in band terms at
 * all, so it never nudges. Inside the band the nudge repeats only after
 * `minDeltaRatio`, and leaving the band is what re-arms it: the caller clears
 * `announcedTokens`, so a session that compacts down and later fills up again
 * hears the warning again instead of staying silent forever.
 *
 * @param input - occupancy, window, band, and the last announcement.
 * @returns whether to publish a nudge for this step.
 */
export function shouldNudge(input: NudgeInput): boolean {
  if (input.contextWindow <= 0) return false
  if (input.contextWindow - input.totalTokens >= input.need) return false
  if (input.announcedTokens === undefined) return true
  return shouldPublish(input.announcedTokens, input.totalTokens, input.minDeltaRatio)
}

/** One nudge reading. */
export interface NudgeRendering {
  /** Route-priced estimated total of the next request. */
  readonly totalTokens: number
  /** Adapter-advertised capacity. */
  readonly contextWindow: number
  /** Rendering of the token numbers. */
  readonly format: ReadingFormat
}

/**
 * Build the model-facing nudge line.
 *
 * The occupancy repeats the ordinary reading so the warning stands on its own in
 * derived history; the clause after it carries what the percentage cannot say —
 * that the remaining headroom is narrower than one ordinary tool result. The
 * advice stays inside what the model can actually do without a compaction tool,
 * so it never points at an action the harness does not offer.
 *
 * @param input - occupancy, window, and rendering.
 * @returns the one-line nudge.
 */
export function renderNudge(input: NudgeRendering): string {
  const total = formatTokenCount(input.totalTokens, input.format)
  const window = formatTokenCount(input.contextWindow, input.format)
  const percent = Math.round((input.totalTokens / input.contextWindow) * 100)
  return `[context: ~${total}/${window} tokens · ${percent}% — one more large tool result can`
    + ' overshoot the window; prefer finishing a unit of work and writing findings to a file]'
}
