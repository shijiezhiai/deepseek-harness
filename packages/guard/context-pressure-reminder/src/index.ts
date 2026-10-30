/**
 * Advisory context-pressure guard. After a tool call it publishes a one-line
 * reading of how full the routed model's context is, and before a step it warns
 * once the remaining headroom is narrower than a recent tool result, so the
 * model can converge its own context use instead of working blind until
 * automatic compaction fires. Configuration and both wordings live in the
 * package README; rationale lives in the context-pressure-reminder Agent Note.
 * @module @deepseek-ai/dsh-context-pressure-reminder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'context-pressure-reminder': { kind: 'context-pressure-reminder' } & ContextFormed
  }
}

import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter/src/types.ts'
import { retainObservations } from './internal.ts'
import type { SessionReadingState } from './internal.ts'
import { dangerNeed, renderNudge, shouldNudge } from './nudge.ts'
import type { DangerBandConfig } from './nudge.ts'
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
   * every step (default `0.02`). Also governs how often a nudge repeats inside
   * the danger band.
   */
  minDeltaRatio?: number
  /** Danger band sizing; see {@link DangerBandConfig}. */
  nudge?: {
    /** Whether the pre-step nudge is installed at all (default `true`). */
    enabled?: boolean
    /** Multiplier applied to the largest recent tool result (default `2`). */
    observationMultiplier?: number
    /** Lower bound on the band as a fraction of the window (default `0.1`). */
    minBandRatio?: number
    /** Upper bound on the band as a fraction of the window (default `0.5`). */
    maxBandRatio?: number
    /** Recent tool results the band is sized from (default `3`). */
    observationWindow?: number
  }
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  precision: z.number().default(1),
  unit: z.union([z.const('k'), z.const('raw')]).default('k'),
  minDeltaRatio: z.number().default(0.02),
  // The outer default names every field: schemastery types `.default()` as the
  // schema's output type, whose members are all required, so `{}` cannot be
  // stated here. Inner defaults still let a composition override just one field.
  nudge: z.object({
    enabled: z.boolean().default(true),
    observationMultiplier: z.number().default(2),
    minBandRatio: z.number().default(0.1),
    maxBandRatio: z.number().default(0.5),
    observationWindow: z.number().default(3),
  }).default({
    enabled: true,
    observationMultiplier: 2,
    minBandRatio: 0.1,
    maxBandRatio: 0.5,
    observationWindow: 3,
  }),
})

/**
 * The source stamped on every reading this guard publishes — the label is
 * load-bearing (an unlabeled context would render as a user prompt in derived
 * history).
 */
const PLUGIN_SOURCE = { kind: 'context-pressure-reminder' } as const

/** The resolved numeric configuration shared by both listeners. */
interface ResolvedConfig {
  /** Rendering of every token count this guard prints. */
  readonly format: ReadingFormat
  /** Smallest relative change worth a fresh reading or a repeated nudge. */
  readonly minDeltaRatio: number
  /** Whether the pre-step nudge is installed. */
  readonly nudgeEnabled: boolean
  /** Band sizing, resolved to concrete numbers. */
  readonly band: DangerBandConfig
}

/** Validate the numeric config fields per the fail-loud contract. */
function resolveFormat(config: Config): ResolvedConfig {
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
  const nudge = config.nudge as NonNullable<Config['nudge']>
  const observationMultiplier = nudge.observationMultiplier as number
  const minBandRatio = nudge.minBandRatio as number
  const maxBandRatio = nudge.maxBandRatio as number
  const observationWindow = nudge.observationWindow as number
  if (!Number.isFinite(observationMultiplier) || observationMultiplier < 0) {
    throw new Error(
      `context-pressure-reminder: invalid nudge.observationMultiplier ${observationMultiplier} — must be a finite number >= 0`,
    )
  }
  for (const [field, value] of [['minBandRatio', minBandRatio], ['maxBandRatio', maxBandRatio]] as const) {
    if (!(value > 0) || value > 1) {
      throw new Error(`context-pressure-reminder: invalid nudge.${field} ${value} — must be in (0, 1]`)
    }
  }
  if (minBandRatio > maxBandRatio) {
    throw new Error(
      `context-pressure-reminder: nudge.minBandRatio ${minBandRatio} exceeds nudge.maxBandRatio ${maxBandRatio}`
      + ' — the band could never reach a size',
    )
  }
  if (!Number.isInteger(observationWindow) || observationWindow < 1) {
    throw new Error(
      `context-pressure-reminder: invalid nudge.observationWindow ${observationWindow} — must be an integer >= 1`,
    )
  }
  return {
    format: { precision, unit },
    minDeltaRatio,
    nudgeEnabled: nudge.enabled as boolean,
    band: { observationMultiplier, minBandRatio, maxBandRatio, observationWindow },
  }
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; numeric fields are re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const { format, minDeltaRatio, nudgeEnabled, band } = resolveFormat(config)

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
      state = {
        step: undefined,
        consideredStepKey: undefined,
        publishedTokens: undefined,
        recentToolSeqs: [],
        announcedTokens: undefined,
      }
      states.set(session, state)
    }
    return state
  }

  // Track the owning step so one step publishes at most one reading: parallel
  // tool calls run post-execute once each, and a per-step count is the only
  // boundary this hook can observe. The same listener keeps the recent tool
  // results the danger band is sized from.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'step/start') {
      stateOf(session).step = { turn: event.data.turn, step: event.data.step }
      return
    }
    if (event.type !== 'tool/result') return
    const state = stateOf(session)
    state.recentToolSeqs = retainObservations([...state.recentToolSeqs, event.seq], band.observationWindow)
  })

  /**
   * Measure the owning session and return the reading to publish, or undefined
   * when this step was already considered or the change is below the debounce.
   *
   * The measurement runs while this step's earlier tool results are on the
   * surface but the current call's result is not yet committed, so the reading
   * understates by roughly this call's output; the next step's reading
   * absorbs that. The `~` prefix and the debounce keep the drift honest.
   *
   * A result carrying `concludesTurn` ends the turn at its step, and stray
   * next-step work reopens that boundary: the inbox drains by running another
   * model request. Publishing there would bill a whole extra request to say
   * nothing the caller still needs, so the reading yields to the conclusion.
   * The step stays spent, because a sibling result of the same batch may still
   * conclude the turn.
   */
  function observe(exec: ToolExecution, result: ToolExecutionResult): UserMessage | undefined {
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
    // sibling result of the same parallel batch, and neither must a concluding one.
    state.consideredStepKey = key
    if (result.concludesTurn === true) return undefined

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
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const reading = observe(exec, result)
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

  if (!nudgeEnabled) return

  /**
   * Measure the pre-step request and return the nudge to append, or undefined
   * when the session is outside the band or inside it without enough change.
   *
   * Unlike {@link observe}, this measures the request the step is about to send,
   * including every node already on the surface. The band is sized from the
   * prices of recent tool results in that same measurement rather than from
   * separate per-result measurements, so a node that later leaves the surface
   * (compaction shadows it) stops influencing the band by itself.
   */
  function nudgeFor(session: Session): UserMessage | undefined {
    const mounted = meter()
    if (mounted === undefined) return undefined
    const contextWindow = session.requestContext()?.contextWindow
    if (contextWindow === undefined) return undefined
    const measurement = mounted.measure(session)
    const state = stateOf(session)
    const prices = new Map(measurement.nodes.map(node => [node.seq, node.tokens]))
    const observations = state.recentToolSeqs.flatMap((seq) => {
      const tokens = prices.get(seq)
      return tokens === undefined ? [] : [tokens]
    })
    const need = dangerNeed(contextWindow, observations, band)
    const inBand = contextWindow - measurement.totalTokens < need
    // Leaving the band is what re-arms the nudge: a session that compacts down
    // and later fills up again hears the warning again.
    if (!inBand) {
      state.announcedTokens = undefined
      return undefined
    }
    if (!shouldNudge({
      totalTokens: measurement.totalTokens,
      contextWindow,
      need,
      announcedTokens: state.announcedTokens,
      minDeltaRatio,
    })) return undefined
    state.announcedTokens = measurement.totalTokens
    return createUserMessage({
      content: [{ type: 'text', text: renderNudge({ totalTokens: measurement.totalTokens, contextWindow, format }) }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'context near the window' },
    })
  }

  // `agent/pre-step`, not `tools/post-execute`: the nudge describes the request
  // about to be sent, and it must land AFTER automatic compaction has had its
  // say — that listener is registered by an earlier composition entry, so this
  // one measures what survived compaction rather than what preceded it.
  // Appending (never `prepend`) preserves that order.
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    // A rejected step never reaches a model request, so it has no request to
    // warn about; its messages array carries no meaning either.
    if (decision.kind === 'reject' || signal.aborted) return decision
    const nudge = nudgeFor(agent.session)
    if (nudge === undefined) return decision
    return { ...decision, messages: [...decision.messages, nudge] }
  })
}
