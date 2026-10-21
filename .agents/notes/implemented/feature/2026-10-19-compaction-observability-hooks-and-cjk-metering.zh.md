# Agent Note: 压缩可观测性、round 钩子与 CJK 感知计量

Status: implemented

[English](2026-10-19-compaction-observability-hooks-and-cjk-metering.md) | 中文

## Problem

压缩会把旧历史藏到摘要后面，但产品回答不了压缩拥有者真正会问的三个问题：

1. **一轮压缩到底有多有效？** `compaction/summary` 事件记录了被 shadow 的 token 数与摘要调用的 usage，但没有对比替换提交前后按计量定价的整体占用，也没有记录事务耗时。没有这些数字，压缩实现的缩减无从可见。
2. **消费者能参与一轮压缩吗？** 唯一扩展点是 `summarize()`——后端子类钩子。想在任何持久变更前否决一轮压缩、或逐轮观察（遥测、分析、UI）的消费者，没有缝可插。
3. **token 计量对中文准吗？** 计量器固定按 4 字符/token 估算：对拉丁文本是合理近似，但对 CJK 表意字和含中文的 JSON schema 块是系统性 3–4× 低估——而这恰恰是 DeepSeek 优先的 harness 最常看到的内容。低估会让自动压力触发滞后、溢出恢复变慢。

## Decision

### 1. 已提交事务上的遥测

`compaction/summary` 新增 `measuredBeforeTokens` 与 `durationMs`；`compaction/end` 与 `CompactionResult` 新增 `measuredAfterTokens`。basic 后端在持锁期间、durable `compaction/start` 之后立刻调用单例 `ctx.tokenMeter.measure(session)` 取 before 成本，在替换提交后再取 after 成本，并在成功关闭时盖上事务耗时。`measuredAfterTokens` 刻意放在 `compaction/end` 而不是 `compaction/summary`：summary 事件在替换**之前**追加，无法诚实陈述替换后的占用。after 值只在无失败记录关闭、且两次计量都在同一已提交代际取到时出现。消费者用 summary 的 `measuredBeforeTokens` 配 end 的 `measuredAfterTokens` 汇报实际缩减。事件保持 log-only——遥测永不进入 surface。

### 2. Round 钩子：面向消费者的第二个扩展点

`CompactionEngine` 新增 `onRound(hook)`（返回 disposer）与两个 protected 执行器。`CompactionRoundHook.before(round)` 返回 `'continue' | 'stop'`，可为 async；`before` 返回 `stop` 会在任何 durable 标记或变更之前中止本轮，且不再咨询后续钩子。`after?(round, result)` 观察每一轮已提交的结果（跳过时为 `null`）；观察者错误被吞掉，因为轮已持久提交。`CompactionRoundContext` 携带 `compactionId`、`kind: 'automatic' | 'manual'`、自动时的 trigger，以及后端计量到时的 before/after 占用。basic 后端把执行器接入它驱动的每一轮：pressure 循环（每次尝试）、context-overflow 强制缩减、`compactNow` 独立的手动轮。既有 `summarize()` 仍是后端的摘要扩展点；`onRound` 是契约的消费者扩展点——无需子类化后端即可观察与否决一轮压缩。

### 3. CJK 感知的 token 估算

`packages/llm/token-meter/src/estimate.ts` 按字符类分段估算。`estimateTextTokens(text)` 逐字符走查：CJK 表意字与全角标点（Han script 加 `\u3000–\u303F`/`\uFF01–\uFF60`）按 1 字符/token 计，Latin 段沿用原来的 4 字符/token + `Math.ceil`。所有原先线性按文本计价的估算器——`estimateContent`、tool-call arguments、`estimateStructuralBlock`、tools、system——一律改用 `estimateTextTokens`。纯 Latin 输入与旧估算器逐位一致，因此既有 109 个计量测试保持全绿，而中文内容定价向真实 tokenization 逼近 3–4×。CJK_CHARS_PER_TOKEN 是具名常量（1），估算器仍收敛于 meter README 记录的固定启发式。

## Alternatives considered

**把 after 占用存在 `compaction/summary` 上。** 拒绝：summary 事件在 surface 替换之前追加，after 字段会是谎言。遥测属于事务的关闭（`compaction/end`），它在替换落库之后追加。

**把遥测做成独立 model-free 后端或 `compaction/telemetry` 事件。** 拒绝：basic 后端已拥有计量位点（两次计量期间它持有锁），新事件会让消费者关联三个事件而非两个。复用既有 `compaction/summary`/`compaction/end` 对加可选数字字段，让协议维持每阶段一个事件。

**把 `runBeforeRound`/`runAfterRound` 暴露成公开契约方法。** 拒绝：执行器强制专用钩子生命周期（stop 短路、after 错误吞掉）。公开面保持最小；只导出 `onRound(hook)` 及其可注销注册。

**用真实 tokenizer 替换固定估算器。** 本次拒绝：tokenizer 是另一项更大的独立投入。字符类估算器是对主导误差（CJK 密度）的正确性修复，对 Latin 零行为变化，且仍是文档化的固定启发式而非飘移的主张。

## Consequences

- 一轮压缩的实际缩减现在是 durable、可配对的遥测：`measuredBeforeTokens`（summary）减 `measuredAfterTokens`（end），外加 `durationMs`。事后与实时消费者无需重放会话或逐个节点减价即可绘制每轮的效果与成本。
- Round 钩子让插件在任何变更前获得否决权，并在每轮已提交后获得可靠观察点，自动与手动路径皆然。设计镜像业界已有的 seam（Codex 的 pre/post compact hooks），同时不把契约耦合到任何 provider。
- 中文为主的 surface 按接近真实 token 数定价，压力准时触发、溢出恢复做更紧的缩减。纯 Latin 负载不变。
- 遥测字段可选且只在干净的代际出现，因此不计量的 model-independent 后端仍是合法的 `CompactionEngine` 实现。

## Testing

- `compaction-basic.spec.ts`：`telemetries the committed before/after footprint and transaction duration` 断言 summary 的 before > 0、任意 duration、summary 无 after、end 的 after > 0、result 的 `measuredAfterTokens` 等于 end 事件的、且 before > after。另有六个钩子测试覆盖每轮 before/after 咨询、stop 且无事件落地、manual kind、disposer 隔离、after 错误被吞、before 错误传播（通过 spec 内的 `ExposedCompactionHooksEngine` 测试子类）。
- `token-meter.spec.ts`：`estimateMessage(textMessage('中文'))` 等于 `2 + 4 + 4`（两个 CJK 字符 + 块开销 + 角色开销）。
- 其余 compaction 套件（204 个测试）与 client typecheck 无变化全绿。
