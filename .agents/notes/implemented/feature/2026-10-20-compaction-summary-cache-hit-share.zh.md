# Agent Note: 压缩 marker 上的缓存命中率

Status: implemented

[English](2026-10-20-compaction-summary-cache-hit-share.md) | 中文

## Problem

对话时间线上的压缩 marker 会汇报本轮 shadow 了多少条历史、大约删掉多少 token，但不汇报摘要请求本身在 prompt cache 上的花费。普通助手回合早已显示自己的缓存命中率（`StatsLine`、`TurnUsageDisclosure`，数据来自 `TokenUsage.cacheReadTokens`），而 `compaction/summary` 从事件契约写下起就携带了摘要调用的 `usage`。客户端从这份 usage 里读出 token 计数，却丢掉了缓存字段——于是那个唯一以重放长前缀为目的的请求，对前缀复用只字不提。

## Decision

### 1. 在提取阶段计算命中率

`CompactionSummaryNode` 新增 `cacheHitPercent: string | null`。`packages/client/ui-chat/src/client/conversation-nodes/command.ts` 的 `compactSummary()` 用摘要事件的 `cacheReadTokens` 除以计费 prompt 总量 `inputTokens + cacheWriteTokens + cacheReadTokens`，并交给 `formatCacheHitPercent` 格式化——其它缓存展示用的都是这个助手。`TokenUsage` 是互斥语义（`inputTokens` 只计未命中缓存的 prompt token），所以这个和就是 provider 实际计费的完整 prompt。事件未携带 `usage`、或输入计数不是安全整数时字段为 `null`，不汇报 usage 的后端与既有会话因此渲染得与之前完全一致。

### 2. 以完整语句渲染

marker 使用第二个完整字符串 key `message.compaction.completedWithCache`（中文与英文），而不是把百分比拼到既有句子上。各语言的百分比短语位置不同，且客户端 UI 文案由语言包拥有：每种语言拿到的是带具名占位符的完整句子，而不是拼装片段。`CompactionItem.tsx` 仅在条数、token 数、命中率三者齐备时才选用带缓存的那个 key。

## Alternatives considered

**在 `CompactionItem.tsx` 内部格式化命中率。** 否决：组件将承担 usage 算术，而提取层本就是事件转视图节点的唯一入口，且可以不渲染就测试。

**只显示百分比、不显示条数与 token 数。** 否决：marker 的首要含义是这轮压缩的规模；孤立的百分比读起来是对不存在之物的统计。

**把缓存字段加到 `CompactionResult` 或 `compaction/end`。** 否决：摘要请求的 usage 在 `compaction/summary` 上就是精确事实，在关闭事件上再复制一份会产生两个可能互相矛盾的值。

**扩展 `TokenUsage` 或新增 session 事件。** 否决：没有必要——缓存字段从 `mapUsage` 写下起就已被映射，summary 事件本就携带完整 `TokenUsage`。

## Consequences

- 压缩 marker 现在能回答"摘要请求的前缀是否命中缓存"，措辞与取整规则与其它所有缓存展示一致：默认整数百分比，接近满命中时用 `99.9x`，部分命中绝不渲染成 100%。
- 摘要事件未携带 usage 的会话、以及不汇报 usage 的后端，保持原句子不变。
- 无 schema、事件或 provider 变更；这是纯派生的展示增量。

## Testing

- `packages/client/ui-chat/tests/chat-branch-tails.client.spec.tsx`：既有摘要测试断言带缓存的句子；新增测试 `shows the summarization cache hit share only when the summary event carried usage` 断言节点带命中率时显示 `100%`、不带时显示原句子。
- `packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts`：自动压缩 fixture 的 `compaction/summary` 携带 usage `{ inputTokens: 1_000, cacheReadTokens: 9_000, cacheWriteTokens: 100 }`，提取出的节点断言 `cacheHitPercent: '89'`。
- `packages/client/ui-chat/tests/chat-view.client.spec.tsx`：压缩节点构造器携带 `cacheHitPercent: '97'`。
- `tsc -b tsconfig.client.json` 与 `verify-client-ui-i18n` 通过；GUI 全量套件通过。
