/**
 * Pure reading renderer and debounce decision for the context-pressure guard.
 * No Cordis context, no session, no clock: every input is a plain value, so the
 * model-facing text and the emit rule are unit-testable without a harness.
 *
 * @module @deepseek-ai/dsh-context-pressure-reminder/pressure
 */

/** How a token count is rendered. */
export interface ReadingFormat {
  /** Fractional digits kept on a `k`-unit count. */
  readonly precision: number
  /** `k` abbreviates thousands; `raw` prints the integer. */
  readonly unit: 'k' | 'raw'
}

/** One reading: the current occupancy and the window it is measured against. */
export interface ReadingInput {
  /** Route-priced estimated total of the next request. */
  readonly totalTokens: number
  /** Adapter-advertised capacity, absent when the route does not publish one. */
  readonly contextWindow?: number | undefined
  /** Rendering of the token numbers. */
  readonly format: ReadingFormat
}

/**
 * Render one token count.
 *
 * A `k`-unit count below one thousand keeps the integer form so early-session
 * readings never read as `~0.3k`.
 *
 * @param tokens - count to render.
 * @param format - unit and fractional digits.
 * @returns the compact model-facing count.
 */
export function formatTokenCount(tokens: number, format: ReadingFormat): string {
  if (format.unit === 'raw' || tokens < 1000) return String(Math.max(0, Math.round(tokens)))
  return `${(tokens / 1000).toFixed(format.precision)}k`
}

/**
 * Build the model-facing reading line.
 *
 * The leading `~` marks the count as an estimate so the model does not treat it
 * as exact arithmetic. The percentage is omitted rather than guessed when the
 * route published no window.
 *
 * @param input - occupancy, window, and rendering.
 * @returns the one-line reading.
 */
export function renderReading(input: ReadingInput): string {
  const total = formatTokenCount(input.totalTokens, input.format)
  const window = input.contextWindow
  if (window === undefined || window <= 0) return `[context: ~${total} tokens]`
  const percent = Math.round((input.totalTokens / window) * 100)
  return `[context: ~${total}/${formatTokenCount(window, input.format)} tokens · ${percent}%]`
}

/**
 * Decide whether a fresh reading is worth a model turn.
 *
 * `minDeltaRatio` suppresses the repetition a burst of small tool calls would
 * otherwise produce: identical numbers on twenty consecutive steps cost tokens
 * and teach the model nothing. A drop is as interesting as a rise, so the rule
 * compares magnitudes.
 *
 * @param previousTokens - occupancy published by the last reading, or undefined
 *   when nothing has been published for this session yet.
 * @param currentTokens - occupancy measured now.
 * @param minDeltaRatio - smallest relative change worth re-reading; `0` always
 *   publishes.
 * @returns whether to publish a reading for `currentTokens`.
 */
export function shouldPublish(
  previousTokens: number | undefined,
  currentTokens: number,
  minDeltaRatio: number,
): boolean {
  if (previousTokens === undefined) return true
  if (minDeltaRatio <= 0) return true
  const change = Math.abs(currentTokens - previousTokens)
  return change / Math.max(previousTokens, 1) >= minDeltaRatio
}
