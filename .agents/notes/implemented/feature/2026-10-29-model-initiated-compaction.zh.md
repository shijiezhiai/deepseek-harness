# Agent Note：模型发起的压缩

Status: implemented

[English](2026-10-29-model-initiated-compaction.md) | 中文

## 问题

harness 里每一次压缩都不是模型发起的。`compaction-basic` 在步边界上发现占用越过 `thresholdRatio` 时压缩，或在提供方以请求过长拒绝后压缩。人可以跑 `/compact`。模型自己没有办法说“我携带的这部分对话已经不再是我需要的”，而它恰恰是唯一知道这件事的一方：过期工具输出是它读的，一次长探索是否已经产出结论、从而可以放手那段过程，也只有它看得见。

因此 `compact_context` 这个工具并不存在，想要它的模型只能花一轮去请求人类。

## 决策

### 1. 请求就是工具调用，回答是随后的一条通知

`packages/compaction/tool-compact` 注册 `compact_context({ focus? })`。工具返回 `{ kind: 'requested' }` 就结束；它声明了 `deferContext`，让循环知道这次调用之后会跟着模型自己推不出来的上下文。

后端那一半在 `compaction-basic` 的 `agent/pre-step` 监听器里。在本步请求组装之前，它折叠会话日志（`request.ts`）找出一个本后端尚未回答的 `compact_context` 调用，闸门通过就压缩，然后追加一条描述结果的通知。通知在下一步作为普通用户消息到达模型，这正是 `deferContext` 去重所针对的位置。

拒绝也是同一形状：拒绝请求的闸门同样追加一条说明原因的通知，于是模型无论结果如何都能知道，不会反复重发一个后端会一直拒的请求。

### 2. 三道闸门，检查成本都为零

`serveModelRequest` 在碰总结器之前就拒绝：

- **占用下限**（`minContextRatio`，默认 `0.10`）：压缩一个几乎空的表面会丢掉模型仍然需要的工作状态，而 token 计量器恰好说明这个表面几乎为空。测得占用低于下限则拒绝。
- **每轮上限**（`maxPerTurn`，默认 `2`）：一轮里已经压缩两次的模型，压缩第三次并不是在推进。
- **本轮已压缩**（无条件）：如果本轮已经记录过一次模型没要求的压缩，模型正在看的表面就不是它测量过的表面。作答会替换掉一段模型还没读过的区域，而日志里的占用数字描述的是压缩前的表面。

第三道闸门正是数字得以保持诚实的原因，同时后端不必去读 `thresholdRatio`，也不必比较时间戳：自动压缩在本轮跑过，这件事本身就是信号。

### 3. Service Definition 完全不动

`CompactionEngine` 仍然只暴露 `compactIfNeeded`、`compactNow`、`compactRegion`、`onRound`。后端把请求服务实现为 `BasicCompactionEngine` 上的私有方法，通过已经处理压力的同一个 `agent/pre-step` 监听器抵达。一个只挂 `tool-compact` 而没有会服务它的后端的组合，工具仍然可见但永远得不到回答——这就是 `serveRequests` 存在的理由：显式关掉行为，而不是悄悄不生效。

`compactRegion` 原样复用；请求目前无法把 `focus` 透传到总结器，所以 `focus` 记录在工具调用上，留待后续变更兑现，而不是悄悄丢弃。

## 考虑过的替代方案

**在工具里同步压缩。** 否决：工具要在循环处于某一步中间时等待一次总结请求，而且模型会把结果当作工具输出读，而不是当作新的表面。推迟到下一步组装，是所有其他压缩输入本来就在的位置。

**为“请求”新增会话事件。** 否决：`tool/call` 事件就是请求，`request.ts` 从日志里把它折叠回来。第二个事件只是重复日志已经携带的事实。

**读 `thresholdRatio` 来决定闸门。** 否决：那根阈值是自动路径的策略，不是模型的。模型在想压缩时提出请求，后端基于自己能测到的东西作答；把两者混为一谈会让一个部署旋钮同时管辖两个互不相关的决定。

**有求必应。** 否决：`maxPerTurn` 与本轮已压缩闸门存在，是因为没有上限的模型循环会反复压缩，毁掉它本想管理的上下文。实测到的失效正是一个模型在表面越过边界后，每一步都发出同一次调用。

## 后果

- 模型现在可以在轮中不经人类回收上下文，且无论结果如何都会读到一条通知。
- `compaction-basic` 新增 `serveRequests` 与 `requestPolicy`；两者都是经校验的配置，可从 `cordis.yml` 改。
- `compact_context` 会出现在每个挂载 `tool-compact` 的组合里，因此工具 schema 快照会变一次。
- `focus` 被接受并记录，但尚未送达总结器。

## 测试

- `packages/compaction/compaction-basic/tests/gate.spec.ts`：下限含等号，低一个 token 即拒绝，`maxPerTurn: 0` 拒绝第一次请求，未知窗口时不做占用判断而服务。
- `packages/compaction/tool-compact/tests/request.spec.ts`：日志折叠每轮只认一次请求，轮结束即退休，忽略其他工具，容忍畸形参数，已作答的请求不会重新打开。
- `packages/compaction/tool-compact/tests/tool.spec.ts`：呈现层在有 focus 时带上标签，否则不出现 `rawInput`。
- `packages/compaction/compaction-basic/tests/request.spec.ts`：真实循环覆盖压缩、一次性拒绝、被压力压缩触发的本轮已压缩闸门，以及 `serveRequests: false`。
