# Agent Note: 压缩代际编号与质量警告

Status: implemented

[English](2026-10-19-compaction-window-numbering-and-quality-warning.md) | 中文

## Problem

反复压缩的会话会在日志里留下一串 `compaction/*` 事件，但协议里没有任何字段回答「这到底是第几次压缩」。三个问题悬而未决：

1. **这个会话被压缩过几次？** 消费者可以数 `compaction/summary` 事件，但数数需要重放整条日志，并且要相信每个 summary 事件都代表独立的一代——per-session 序号直接给出了答案。
2. **模型对早期历史的记忆是否在退化？** 第一次压缩后模型读的是原始历史的摘要；多轮压缩后，它读的是摘要的摘要。业界会把这种保真度损失告诉用户（Codex 在多代压缩窗口后打印警告，"long threads may be less accurate"）。DSH 客户端对每个 marker 渲染得一模一样，第二代摘要看起来和第一代一样可信。
3. **插件能否锚定每一代的来源？** 差距报告路线图想让第 N 代的被遮蔽原文以后可检索；落地的 checkpoint 上需要一个稳定序号，作为插件和未来检索的锚点。

## Decision

### 1. summary 事件上的 per-session、可重放窗口序号

`compaction/summary` 新增可选 `windowNumber`：per-session 从 1 起的序号，**只计成功完成摘要的压缩**。失败轮与 `compaction/prune`（根本没有 summary）不推进计数器，因为编号描述的是「模型看到的第几代」而非尝试次数。basic 后端通过自己 append-only 日志的 `nextCompactionWindowNumber(events)` 派生：扫描已落地的 `compaction/summary` 事件取最大 `windowNumber` 再加一——序号是会话日志的纯函数，可重放、崩溃一致，不需要新的持久化状态。`CompactionResult` 镜像该字段。模型无关的后端可以省略（保持可选），客户端对没有编号的旧会话渲染为普通标签。

### 2. 客户端按代编号，从第二代起警告

先在 `CompactionSummaryNode` 补齐协议字段（`windowNumber: number | null`），`compactSummary` 读 `data.windowNumber`（只接受 ≥1 的安全整数）。随后 `CompactionItem`：

- 有窗口号时把标题渲染为 `第 {n} 代压缩` / `Compaction #{n}`（显式命令标题仍然优先）；
- `windowNumber ≥ 2` 时显示一行质量提示——*"多次压缩后，模型对早期对话的记忆可能不准"* / *"After repeated compactions, the model may be less accurate about early conversation details"*——渲染为 `role="note"` 段落；
- 保持标记干净：提示每个 marker 只渲染一次，零模型 token（纯 UI 文案，主题色琥珀标签），不向模型流注入任何新信息。

### 3. 生态的来源锚点

`windowNumber` 落在 checkpoint 上，给插件一个稳定的逐代键：拿到序号，插件可以走会话日志精确恢复每一代遮蔽了哪些区间。检索/解压仍归插件生态（billion-context），与 shadowed 区间镜像的决定一致（2026-10-19）；编号是 DSH 侧让该检索确定性的锚点。

## Alternatives considered

**在 `compaction/start` 提前分配代际号。** 否决：start 可能永远不落 summary（veto、失败、重试），把尝试当世代会让模型视野的编号跳号。在提交时从已落地的 summary 派生，保证序号恒等于「模型视野的世代」。

**把计数器存成新的后端持久化状态。** 否决：append-only 日志已经记录了每个落地的 summary；独立计数器必须与日志事务一致，还会破坏新后端的重放。对日志求 max+1 幂等、崩溃安全、零成本。

**把警告接进模型流（例如 system prompt 一句）。** 否决：让模型自我提醒记忆退化，每轮烧 token 且没有可行动信号；警告是对用户的提示，只放在客户端。

## Consequences

- 消费者不用重放日志就能回答「这是第几次压缩」：`windowNumber` 在 summary 事件与 `CompactionResult` 上都有。
- 客户端在视觉上区分世代，并从第二代起提示，对齐业界对反复压缩保真度损失的警告，且不花模型 token。
- 插件得到确定性的逐代来源锚点；编号从日志派生，重放与崩溃恢复产生相同序号。
- 契约上字段可选：不测量的后端与旧会话日志仍然有效。

## Testing

- `compaction-basic.spec.ts`：`derives the next window ordinal from landed summaries only`（空日志→1，一个 summary→2，两个→3，随后一次失败轮加一次 prune 仍→3）与 `assigns monotonically increasing windows across repeated compactions`（两次成功轮分别落地 1、2；失败尝试不推进计数）。
- `chat-branch-tails.client.spec.tsx`：窗口 fixture 标题为 `第 N 代压缩`；第二代起渲染反复压缩警告，第一代与旧会话不渲染。
- `conversation-node-definitions.client.spec.ts`：携带 `windowNumber: 3` 的自动压缩 summary 经 `compactSummary` 流入节点。
- 全量门禁：compaction 套件 206 tests、client `tsc`（tsconfig.client.json）、完整 `test:gui` 套件（288 个文件、3,824 tests）通过。
