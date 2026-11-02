/**
 * Session-archival listener: on every human-authored `user/message` event,
 * append one timeline row to the session's active project and refresh
 * `lastActiveAt`. Harness-injected `user/message` events — runtime context,
 * skill and tool catalogs, instructions, mnemon recalls, approval policy,
 * compaction checkpoints, background-job notices — declare their own
 * `source.kind` and are skipped.
 *
 * An agent-message relay also reaches a session as `user/message` and belongs
 * in its timeline, so it is matched by `form` — its `agent-message` kind is a
 * deliberate placeholder, not a producer-level identifier.
 * Mirrors GA's `project_sessions.py` agent_after hook — and, like it, stays
 * fail-open: any failure is reported through `warn` and never blocks the
 * session loop.
 * @module dsh-project-mode/src/archive
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { ProjectStore } from './store.ts';
import { buildTimelineEntry, truncateText } from './timeline.ts';
export interface ArchiveOptions {
    /** When false the listener is a no-op (config `archiveTimeline`). */
    enabled: boolean;
    /** Diagnostic sink for archival failures; must not throw. */
    warn(message: string): void;
}
/** Text content block as read from a `user/message` payload. */
type TextBlock = { type: 'text'; text: string };
/**
 * Join the human-visible text of a `user/message` payload, tolerating both
 * string payloads and content-block lists. Whitespace is collapsed but the
 * result is NOT truncated, so callers can inspect the whole message.
 * @param data - `user/message` event `data` field, or any unknown payload.
 * @returns whitespace-collapsed, trimmed text; empty when there is none.
 */
function userText(data: unknown): string {
    if (typeof data === 'string')
        return data.replace(/\s+/g, ' ').trim();
    if (typeof data !== 'object' || data === null)
        return '';
    const content = (data as { content?: unknown }).content;
    if (typeof content === 'string')
        return content.replace(/\s+/g, ' ').trim();
    if (Array.isArray(content)) {
        const text = content
            .filter((block): block is TextBlock => typeof block === 'object' && block !== null
            && block.type === 'text' && typeof block.text === 'string')
            .map(block => block.text)
            .join('');
        return text.replace(/\s+/g, ' ').trim();
    }
    return '';
}
/**
 * Extract the human-visible text of a `user/message` event payload, truncated
 * to one timeline row.
 * @param data - `user/message` event `data` field, or any unknown payload.
 * @returns concatenated text-block content, whitespace-collapsed and trimmed.
 */
export function extractUserText(data: unknown): string {
    return truncateText(userText(data));
}
/**
 * Whether a `user/message` payload was authored for this session's reader
 * rather than injected by the harness: a `user` source, or any source declaring
 * the `relay` context form. Producers declare their own `kind`, so an unknown
 * kind without that form is not a timeline row.
 * @param data - `user/message` event `data` field, or any unknown payload.
 * @returns true for user-authored and relayed messages.
 */
export function isTimelineMessage(data: unknown): boolean {
    if (typeof data !== 'object' || data === null)
        return false;
    const source = (data as { source?: unknown }).source;
    if (typeof source !== 'object' || source === null)
        return false;
    return (source as { kind?: unknown }).kind === 'user' || (source as { form?: unknown }).form === 'relay';
}
/**
 * Create the `session/event` listener for one store.
 * @param store - project store to read activations from and write rows to.
 * @param options - enabled flag and failure sink.
 * @returns a listener shaped for `ctx.on('session/event', ...)`; also safe to
 * call directly with structurally compatible stubs in tests.
 */
export function createTimelineArchiver(store: ProjectStore, options: ArchiveOptions): (session: Session, event: SessionEvent) => void {
    return (session, event) => {
        if (!options.enabled || event.type !== 'user/message')
            return;
        if (!isTimelineMessage(event.data))
            return;
        try {
            const name = store.getActiveSync(String(session.id));
            if (name === null)
                return;
            const row = buildTimelineEntry(event.seq, extractUserText(event.data));
            void store.appendTimeline(name, row).catch(report);
            void store.touch(name).catch(report);
        }
        catch (error) {
            report(error);
        }
        function report(error: unknown): void {
            options.warn(`timeline archival failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
}
