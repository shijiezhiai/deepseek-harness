/**
 * Session-timeline row formatting. Rows are single-line Markdown so the
 * timeline stays grep-able and `timelineTail` can slice them cheaply.
 * @module dsh-project-mode/src/timeline
 */
/**
 * Collapse whitespace and truncate to `max` chars, appending an ellipsis. A
 * long user message must not break the row's line structure.
 * @param text - raw text.
 * @param max - maximum length.
 * @returns a single-line string no longer than `max + 1` chars.
 */
export function truncateText(text: string, max = 80): string {
    const flat = String(text).replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
/**
 * Local wall-clock timestamp `YYYY-MM-DD HH:mm`.
 * @param date - instant to format; defaults to now.
 * @returns the formatted timestamp.
 */
export function formatLocalTimestamp(date: Date = new Date()): string {
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/**
 * One timeline row. The `seq` is the source `user/message` event sequence,
 * so the row is traceable back to the session log.
 * @param seq - source event sequence number.
 * @param text - truncated user text.
 * @returns a complete `## ...` row, without a trailing newline.
 */
export function buildTimelineEntry(seq: number, text: string, ts: string = formatLocalTimestamp()): string {
    return `## ${ts} | seq=${seq} | user: ${text}`;
}
