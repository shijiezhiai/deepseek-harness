/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-context-pressure-reminder`.
 * @module @deepseek-ai/dsh-context-pressure-reminder/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-context-pressure-reminder'

/** Cordis companion plugin name. */
export const name = 'context-pressure-reminder-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the reading is private to one post-execute listener,
 * its state is a per-session debounce counter in a `WeakMap`, and the only
 * durable record it produces is an ordinary `agent/inbox/spliced` splice that
 * the session log already validates. An independent companion therefore owns
 * no event or snapshot to assert.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
