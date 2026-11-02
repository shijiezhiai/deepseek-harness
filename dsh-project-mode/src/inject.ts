/**
 * Per-turn L1 injection through the system-prompt section registry. The
 * provider is evaluated on every assembly with the assembling agent, reads the
 * agent's active project synchronously, and returns the L1 block — GA's
 * `agent_before` hook, adapted to DSH's per-session assembly model.
 * @module dsh-project-mode/src/inject
 */

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { buildL1Block } from './l1.ts';
import type { ProjectStore } from './store.ts';
/** Section identity; one global registration, per-agent overrides use the same name. */
export const PROJECT_SECTION_NAME = 'project-mode:context';
/**
 * Section order, between `PLAN_POLICY` (500) and `TEAM_POLICY` (600) of
 * `FIRST_PARTY_SECTION_ORDER` — deployment context, not a tool policy.
 */
export const PROJECT_SECTION_ORDER = 550;
export interface InjectOptions {
    /** When false the section contributes nothing (config `injectContext`). */
    enabled: boolean;
}
/**
 * Register the L1 section in `ctx`'s scope. Registration is a Cordis effect:
 * disposing the plugin fiber unregisters the section.
 * @param ctx - plugin context exposing `systemPrompt`.
 * @param store - project store consulted per assembly.
 * @param options - enabled flag.
 */
export function registerProjectSection(ctx: Context, store: ProjectStore, options: InjectOptions): void {
    ctx.systemPrompt.section({
        name: PROJECT_SECTION_NAME,
        order: PROJECT_SECTION_ORDER,
        text: (context) => {
            if (!options.enabled)
                return '';
            const agent = context.agent;
            if (agent === undefined)
                return '';
            const name = store.getActiveSync(String(agent.id));
            if (name === null)
                return '';
            return buildL1Block(store.l1MaterialSync(name));
        },
    });
}
