/**
 * The model-facing `compact_context` tool: a request, not an action.
 *
 * A tool cannot compact inline — `compactNow` reserves an idle agent, while a
 * tool body always runs inside the agent's `running` phase. The call therefore
 * only records the request: the `tool/call` event is the durable request, and the
 * compaction backend claims it at the next `agent/pre-step`, where the agent is
 * between steps and a replacement can be committed.
 *
 * Because the request needs nothing but its own logged call, this tool is pure:
 * it registers a schema, renders an acknowledgement, and owns no state. Whether
 * the request is served is the backend's policy, and whether it is a sensible
 * request is the backend's gate.
 *
 * Configuration and wording live in the package README; rationale lives in the
 * context-compact-tool Agent Note.
 *
 * @module @deepseek-ai/dsh-tool-compact
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { COMPACT_TOOL_NAME } from './request.ts'

export { COMPACT_TOOL_NAME, pendingCompactionRequest } from './request.ts'
export type { CompactionRequest } from './request.ts'

export const name = 'tool-compact'

/** Ids injected before {@link apply} runs. */
export const inject = ['tools']

const DESCRIPTION =
  'Replace the finished part of this conversation with one summary, freeing context '
  + 'space while keeping the work that matters. Use it when earlier turns hold detail '
  + 'you will not need again — before the context fills up. Compaction runs before your '
  + 'next step, not immediately: this call only records the request, and the harness may '
  + 'decline it. Pass `focus` naming what the summary must preserve when that matters '
  + '(decisions already made, files you are editing, facts you will need again).'

/** The one value `compact_context` returns. */
interface Acknowledged {
  readonly kind: 'requested'
}

/**
 * Register `compact_context` on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: COMPACT_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      focus: {
        type: 'string',
        description: 'One sentence naming what the summary must preserve. Omit when nothing specific matters.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['requested'] },
        },
      },
      render: () => [{
        type: 'text',
        text: 'Compaction requested. It will run before your next step; keep working until then.',
      }],
    },
    execute(): Promise<Acknowledged> {
      // The `tool/call` event this execution came from IS the durable request;
      // the backend claims it by name at the next pre-step. Nothing to append,
      // and nothing to measure: the tool does not know what compaction will cost.
      return Promise.resolve({ kind: 'requested' })
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Request compaction',
      kind: 'other',
      rawInput: args.focus === undefined ? {} : { focus: args.focus },
    }),
  }))
}
