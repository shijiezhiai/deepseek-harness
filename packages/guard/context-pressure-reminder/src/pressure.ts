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

/**
 * Default cap on the per-turn entries one reading prints.
 *
 * Each entry costs about six characters on every published reading, so the cap
 * bounds what a long session pays to describe itself. A configuration overrides
 * it through `maxTurnsInReading`; this constant is that field's documented
 * default, not a fixed choice.
 */
export const DEFAULT_MAX_TURNS_IN_READING = 8

/** One turn's share of the measured surface. */
export interface TurnSize {
  /** Absolute session turn number. */
  readonly turn: number
  /** Route-priced estimated tokens this turn still holds on the surface. */
  readonly tokens: number
}

/** One reading: the current occupancy and the window it is measured against. */
export interface ReadingInput {
  /** Route-priced estimated total of the next request. */
  readonly totalTokens: number
  /** Adapter-advertised capacity, absent when the route does not publish one. */
  readonly contextWindow?: number | undefined
  /** Rendering of the token numbers. */
  readonly format: ReadingFormat
  /**
   * Per-turn occupancy, ascending by turn. Absent, empty, or single-entry
   * sequences print nothing: with one turn the sizes restate the total, and a
   * reading that repeats itself teaches the model nothing.
   */
  readonly turns?: readonly TurnSize[] | undefined
  /**
   * Cap on how many turn entries print, keeping the newest. Defaults to
   * {@link DEFAULT_MAX_TURNS_IN_READING}.
   */
  readonly maxTurns?: number | undefined
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
 * Render the per-turn suffix, or the empty string when it would not inform.
 *
 * The omitted older turns collapse into one `earlier` figure so the printed
 * numbers still add up to the turn total: a model weighing which turns to
 * compact needs an additive picture, and a bare `+5 turns` would deny it one.
 *
 * @param turns - ascending per-turn sizes.
 * @param format - unit and fractional digits.
 * @param maxTurns - how many newest entries print.
 * @returns the suffix beginning with ` · `, or `''` when nothing is printed.
 */
function renderTurns(turns: readonly TurnSize[], format: ReadingFormat, maxTurns: number): string {
  if (turns.length < 2 || maxTurns < 1) return ''
  const printed = turns.slice(-maxTurns)
  const omitted = turns.length - printed.length
  const first = printed[0] as TurnSize
  const last = printed[printed.length - 1] as TurnSize
  const sizes = printed.map(entry => formatTokenCount(entry.tokens, format)).join(' ')
  const label = first.turn === last.turn ? `turn ${first.turn}` : `turns ${first.turn}-${last.turn}`
  if (omitted === 0) return ` · ${label}: ${sizes}`
  const earlierTurns = turns.slice(0, omitted)
  const earlier = earlierTurns.reduce((sum, entry) => sum + entry.tokens, 0)
  const earlierFirst = earlierTurns[0] as TurnSize
  const earlierLast = earlierTurns[earlierTurns.length - 1] as TurnSize
  const earlierLabel = earlierFirst.turn === earlierLast.turn
    ? `turn ${earlierFirst.turn}`
    : `turns ${earlierFirst.turn}-${earlierLast.turn}`
  return ` · earlier ${earlierLabel}: ${formatTokenCount(earlier, format)} · ${label}: ${sizes}`
}

/**
 * Split the measured surface nodes into per-turn sizes.
 *
 * A node belongs to the newest turn whose `turn/start` preceded it, which is
 * exact because `turn/start` is a turn's first append. Positional order is not
 * consulted: a compaction checkpoint is spliced into the surface at the
 * shadowed region's start while carrying a far newer sequence number, so the
 * node array stops being sequence-ordered after any compaction.
 *
 * Turns holding no node are dropped rather than printed as zero — an empty turn
 * has nothing to compact. Compaction removes shadowed nodes, so a compacted
 * session naturally reports only the turns that still hold surface content.
 *
 * @param nodes - measured surface nodes with their prices.
 * @param turnStarts - ascending turns with the sequence number each started at.
 * @returns ascending per-turn sizes, possibly empty.
 */
export function turnSizes(
  nodes: readonly { readonly seq: number; readonly tokens: number }[],
  turnStarts: readonly { readonly turn: number; readonly seq: number }[],
): TurnSize[] {
  if (turnStarts.length === 0) return []
  const totals = new Map<number, number>()
  for (const node of nodes) {
    // Binary search for the newest turn start at or before this node.
    let low = 0
    let high = turnStarts.length - 1
    let found = -1
    while (low <= high) {
      const mid = (low + high) >> 1
      if ((turnStarts[mid] as { readonly seq: number }).seq <= node.seq) {
        found = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    if (found === -1) continue
    const turn = (turnStarts[found] as { readonly turn: number }).turn
    totals.set(turn, (totals.get(turn) ?? 0) + node.tokens)
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left - right)
    .map(([turn, tokens]) => ({ turn, tokens }))
}

/**
 * Build the model-facing reading line.
 *
 * The leading `~` marks the count as an estimate so the model does not treat it
 * as exact arithmetic. The percentage is omitted rather than guessed when the
 * route published no window.
 *
 * @param input - occupancy, window, rendering, and the optional per-turn split.
 * @returns the one-line reading.
 */
export function renderReading(input: ReadingInput): string {
  const total = formatTokenCount(input.totalTokens, input.format)
  const turns = renderTurns(input.turns ?? [], input.format, input.maxTurns ?? DEFAULT_MAX_TURNS_IN_READING)
  const window = input.contextWindow
  if (window === undefined || window <= 0) return `[context: ~${total} tokens${turns}]`
  const percent = Math.round((input.totalTokens / window) * 100)
  return `[context: ~${total}/${formatTokenCount(window, input.format)} tokens · ${percent}%${turns}]`
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
