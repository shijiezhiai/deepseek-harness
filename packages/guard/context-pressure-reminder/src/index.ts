/**
 * Advisory context-pressure guard. After a tool call it publishes a one-line
 * reading of how full the routed model's context is, so the model can converge
 * its own context use instead of working blind until automatic compaction
 * fires. Configuration and the reading's wording live in the package README;
 * rationale lives in the context-pressure-reminder Agent Note.
 * @module @deepseek-ai/dsh-context-pressure-reminder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter/src/types.ts'
import type { SessionReadingState } from './internal.ts'
import { renderReading, shouldPublish } from './pressure.ts'
import type { ReadingFormat } from './pressure.ts'

export const name = 'context-pressure-reminder'

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time checks in `apply` (misconfiguration fails loud: a negative
 * precision, an unknown unit, or a negative ratio throws at plugin load, never
 * a silent fall-back).
 */
export interface Config {
  /** Whether readings are published at all (default `true`). */
  enabled?: boolean
  /** Fractional digits kept on a `k`-unit count (default `1`). */
  precision?: number
  /** `k` abbreviates thousands; `raw` prints the integer (default `k`). */
  unit?: 'k' | 'raw'
  /**
   * Smallest relative occupancy change worth a fresh reading; `0` publishes on
   * every step (default `0.02`).
   */
  minDeltaRatio?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  precision: z.number().default(1),
  unit: z.union([z.const('k'), z.const('raw')]).default('k'),
  minDeltaRatio: z.number().default(0.02),
})

/**
 * The `{kind:'plugin'}` source stamped on every reading this guard publishes —
 * the label is load-bearing (an unlabeled context would render as a user
 * prompt in derived history).
 */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'context-pressure-reminder' } as const satisfies MessageSource

/** Validate the numeric config fields per the fail-loud contract. */
function resolveFormat(config: Config): { format: ReadingFormat; minDeltaRatio: number } {
  // schemastery's .default() guarantees the fields are set after validation.
  const precision = config.precision as number
  if (!Number.isInteger(precision) || precision < 0) {
    throw new Error(`context-pressure-reminder: invalid precision ${precision} — must be an integer >= 0`)
  }
  const unit = config.unit as 'k' | 'raw'
  const minDeltaRatio = config.minDeltaRatio as number
  if (!Number.isFinite(minDeltaRatio) || minDeltaRatio < 0) {
    throw new Error(`context-pressure-reminder: invalid minDeltaRatio ${minDeltaRatio} — must be a finite number >= 0`)
  }
  return { format: { precision, unit }, minDeltaRatio }
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; numeric fields are re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const { format, minDeltaRatio } = resolveFormat(config)

  // The meter is looked up rather than injected: an `inject` declaration would
  // make a composition that forgot the meter silently load no guard at all,
  // and that omission is exactly what an operator needs to see. The lookup is
  // per tool call rather than per load so a meter mounted after this plugin
  // still feeds it.
  let warnedMissingMeter = false
  /** The mounted meter, or undefined after warning once. */
  const meter = (): TokenMeter | undefined => {
    const mounted = ctx.get('tokenMeter')
    if (mounted !== undefined) return mounted
    if (!warnedMissingMeter) {
      warnedMissingMeter = true
      ctx.logger.warn('context-pressure-reminder: no token meter mounted; context readings are disabled')
    }
    return undefined
  }

  const states = new WeakMap<Session, SessionReadingState>()
  const stateOf = (session: Session): SessionReadingState => {
    let state = states.get(session)
    if (state === undefined) {
      state = { step: undefined, consideredStepKey: undefined, publishedTokens: undefined }
      states.set(session, state)
    }
    return state
  }

  // Track the owning step so one step publishes at most one reading: parallel
  // tool calls run post-execute once each, and a per-step count is the only
  // boundary this hook can observe.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'step/start') return
    stateOf(session).step = { turn: event.data.turn, step: event.data.step }
  })

  /**
   * Measure the owning session and return the reading to publish, or undefined
   * when this step was already considered or the change is below the debounce.
   *
   * The measurement runs while this step's earlier tool results are on the
   * surface but the current call's result is not yet committed, so the reading
   * understates by roughly this call's output; the next step's reading
   * absorbs that. The `~` prefix and the debounce keep the drift honest.
   */
  function observe(exec: ToolExecution): UserMessage | undefined {
    // A direct `ctx.tools.execute()` caller has no agent, hence no session to
    // read and no model to inform.
    const agent = exec.agent
    if (agent === undefined) return undefined
    const mounted = meter()
    if (mounted === undefined) return undefined
    const { session } = agent
    const state = stateOf(session)
    const step = state.step
    const key = step === undefined ? undefined : `${step.turn}/${step.step}`
    if (key !== undefined && state.consideredStepKey === key) return undefined
    // The step is spent either way: a debounced step must not retry on every
    // sibling result of the same parallel batch.
    state.consideredStepKey = key

    const measurement: TokenMeasurement = mounted.measure(session)
    if (!shouldPublish(state.publishedTokens, measurement.totalTokens, minDeltaRatio)) return undefined
    state.publishedTokens = measurement.totalTokens
    const contextWindow = session.requestContext()?.contextWindow
    return createUserMessage({
      content: [{ type: 'text', text: renderReading({ totalTokens: measurement.totalTokens, contextWindow, format }) }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'context pressure' },
    })
  }

  // Observe-and-enrich, never veto: DELEGATE so a later listener can still
  // block or replace, then fold the reading onto whatever came back —
  // additionalContexts rides both decision variants, so a blocked call still
  // gets the reading. The loop appends it to the next-step inbox, which places
  // it after every tool result of this step, never between a call and its
  // result.
  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const reading = observe(exec)
    const downstream = await next()
    if (reading === undefined) return downstream
    if (downstream.kind === 'block') {
      return {
        kind: 'block',
        feedback: downstream.feedback,
        additionalContexts: [reading, ...downstream.additionalContexts ?? []],
      }
    }
    return {
      ...downstream,
      additionalContexts: [reading, ...downstream.additionalContexts ?? []],
    }
  })
}
