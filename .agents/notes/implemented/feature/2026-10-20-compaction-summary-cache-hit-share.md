# Agent Note: cache hit share on the compaction marker

Status: implemented

English | [中文](2026-10-20-compaction-summary-cache-hit-share.zh.md)

## Problem

The compaction marker in the conversation timeline reported how many history items a round shadowed and roughly how many tokens it removed, but not what the summarization request itself cost against the prompt cache. Every ordinary assistant turn already displays its cache hit share (`StatsLine`, `TurnUsageDisclosure`) from `TokenUsage.cacheReadTokens`, and `compaction/summary` has carried the summarization call's `usage` since the event contract was written. The client read the token counts off that usage and dropped the cache fields, so the one request whose entire purpose is replaying a large prefix — the summarization call — reported nothing about prefix reuse.

## Decision

### 1. Compute the share during extraction

`CompactionSummaryNode` gains `cacheHitPercent: string | null`. `compactSummary()` in `packages/client/ui-chat/src/client/conversation-nodes/command.ts` divides the summary event's `cacheReadTokens` by the billed prompt total `inputTokens + cacheWriteTokens + cacheReadTokens` and formats it with `formatCacheHitPercent`, the helper every other cache display uses. `TokenUsage` is disjoint (`inputTokens` counts only uncached prompt tokens), so that sum is the full prompt the provider priced. The field is `null` when the event carried no `usage` or a non-safe input count, which keeps backends that do not report usage and pre-existing sessions rendered exactly as before.

### 2. Render as a complete locale sentence

The marker uses a second complete-string key, `message.compaction.completedWithCache` (zh and en), instead of concatenating a percentage onto the existing sentence. Locales order the percent phrase differently, and client UI copy is locale-owned: each language receives whole sentences with named placeholders, never assembled fragments. `CompactionItem.tsx` picks the with-cache key only when the item count, token count, and share are all present.

## Alternatives considered

**Formatting the share inside `CompactionItem.tsx`.** Rejected: the component would carry the usage arithmetic, while extraction is already the single place that turns events into view nodes and can be tested without rendering.

**Showing the percentage without the item and token counts.** Rejected: the marker's primary meaning is the scale of the compaction; a percent alone reads as a statistic about nothing.

**Adding cache fields to `CompactionResult` or `compaction/end`.** Rejected: the summarization request's usage on `compaction/summary` is the exact fact, and duplicating it on the close event would create two values that can disagree.

**Extending `TokenUsage` or adding a session event.** Rejected as unnecessary: the cache fields have been mapped from the provider since `mapUsage` was written and the summary event already carries the whole `TokenUsage`.

## Consequences

- The compaction marker now answers "was the summarization prefix cached" with the same wording and rounding as every other cache display: an integer percent by default, `99.9x` near a full hit so a partial hit never renders as 100%.
- Sessions whose summary events carry no usage, and backends that do not report usage, keep the previous sentence unchanged.
- No schema, event, or provider change; the addition is display-only and derived.

## Testing

- `packages/client/ui-chat/tests/chat-branch-tails.client.spec.tsx`: the existing summary test asserts the with-cache sentence, and a new test `shows the summarization cache hit share only when the summary event carried usage` asserts `100%` when the node carries a share and the plain sentence when it does not.
- `packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts`: the automatic-compaction fixture's `compaction/summary` carries usage `{ inputTokens: 1_000, cacheReadTokens: 9_000, cacheWriteTokens: 100 }`, and the extracted node asserts `cacheHitPercent: '89'`.
- `packages/client/ui-chat/tests/chat-view.client.spec.tsx`: the compaction node builder carries `cacheHitPercent: '97'`.
- `tsc -b tsconfig.client.json` and `verify-client-ui-i18n` pass; the full GUI suite passes.
