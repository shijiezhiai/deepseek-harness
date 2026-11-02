# 读数加分轮大小 —— 方案

已实现（`260e224924` 之后的提交）。对应 `.agents/notes/proposed/feature/2026-11-02-model-chosen-compaction-range.md` 的实施顺序第 1 步；实现与本文的三处差异记在 §8。

## 1. 这一步要解决什么

第 1 步的动机来自第 3 步 `throughTurn`：模型要选「压到第几轮为止」，前提是它知道每一轮多大。当前读数只报一个总量 `[context: ~48.2k/128.0k tokens · 38%]`，模型无法判断「第 5 轮很便宜、第 9 轮那次巨大 grep 才是大头」。

所以第 1 步的产出是一行让模型能按轮估量的读数，而不是一项新能力。

## 2. 先给结论：原计划照原样做会伤到 167 个快照

Note 里第 1 步的风险栏写的是「medium — model-visible text, full snapshot refresh」。实测这个估计偏小，而且偏小的方向会误导施工决策：

- 含读数的快照文件 **167 个**（`grep -rl "\[context: ~" snapshots/` 的 182 个里，5 个是 notifications sidecar 不含 turn/start）。
- 其中 **163 个整个会话只有 1 轮**，读数落在第 2 轮及以后的只有 **4 个**。

第一轮之内没有「分轮」可言。若把分轮摘要无条件加进读数，163 个单轮快照会全部改写，而且改出来的内容是 `[context: ~6.0k tokens · turns: 1=6.0k]` 这种对模型零价值的冗语——一轮的时候「每一轮多大」等于总量，重复一遍。

**因此方案的核心不是「怎么算分轮」，而是「什么时候不显示」。**

## 3. 显示规则

分轮摘要只在**存在至少两个可折叠轮次**时附加。判据是「surface 上被至少两个不同 turn 占有」，不是「日志里有几次 turn/start」——`turn/start` 会被压缩遮蔽，见 §5。

三种形态：

| 情形 | 读数 |
|---|---|
| 0 或 1 个轮次占有 surface | `[context: ~6.0k tokens]`（现状，逐字节不变） |
| ≥2 个轮次 | `[context: ~48.2k tokens · turns 1-3: 2.1k 8.7k 31.4k]` |
| 有窗口且 ≥2 轮 | `[context: ~48.2k/128.0k tokens · 38% · turns 1-3: 2.1k 8.7k 31.4k]` |

这样 163 个单轮快照完全不受影响，只有 4 个多轮快照需要重录，而且它们本来就是要被读的。

### 为什么列出全部轮次而不是只列最近 3 轮

列最近 3 轮需要额外规则解释「为什么是 3」和「前面还有多少没列」，而模型要回答的问题（「压到第几轮为止比较划算」）需要全貌。轮次数在实际会话里不会大到失控：一个 100 步会话通常 10–30 轮，每轮 6 个字符左右的数字。

**但如果轮次超过某阈值就必须截断**，否则长会话的读数会变成一条几百字符的正文，比它描述的内容还贵。截断策略见 §7 的未决问题。

## 4. 怎么算每一轮的大小

### 4.1 数据来源：`measurement.nodes` 已经够用，不需要碰日志

`TokenSurfaceNode`（`packages/llm/token-meter/src/types.ts:38-56`）有 `seq`、`tokens`、`heuristicTokens`。`seq` 与 `turn/start` 的 seq 同属一个序列空间，因此**只需要一张 `seq → turn` 的映射表**就能把节点价按轮聚合。

### 4.2 映射表用增量累积，不每步回扫

关键约束：`measure()` 每步已经是 O(surface) 并做 `structuredClone`（`packages/llm/token-meter/src/index.ts:145` 的 JSDoc：「Every call clones those positional nodes, so measurement is O(surface)」）。若读数再扫一遍日志做 turn join，每步就多一次 O(surface)。

仓库对该问题的既定答案是 projection（`.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`），而 guard 已经在 `session/event` 监听器里维护状态（`packages/guard/context-pressure-reminder/src/index.ts:207-217`，维护 `step` 与 `recentToolSeqs`）。同一处再记一个 `Map<SessionSeq, number>` 是零额外扫描。

`turn/start` 是每轮第一个 append（`packages/core/agent-loop/src/agent.ts:336` 在 `turn()` 里第一件事就是 `session.append('turn/start', { turn })`），晚于它的 surface 节点都属于该轮。

### 4.3 累积的时机

监听器已经收到每个 `session/event`（`packages/core/session/src/index.ts:899` 的 `invokeContainedSessionObservers(..., 'session/event', ...)`），所以在 `turn/start` 时记下「当前轮号 + 其起始 seq」，在 surface 事件时把「该事件 seq → 当前轮号」写进映射。

要注意 `user/message` / `assistant/message` / `tool/result` 三种 surface 类型（`packages/core/session/src/surface.ts:50-56` 的 `SURFACE_EVENT_TYPES`，`tool/call` 不在其中），但**不需要**在监听器里逐条判断：只要记录 `turn/start` 的 seq，聚合时用「节点 seq ≥ 某 turn 起始 seq 且 < 下一个 turn 起始 seq」二分即可，映射表只存轮次起始 seq。

这个做法更省：每轮一次写入，而不是每个 surface 事件一次写入。

### 4.4 压缩之后会怎样

`foldSurface` 返回的 `state.nodes` 是**当前 surface 的节点**（`packages/core/session/src/surface.ts:608`），被 replace 遮蔽的节点不在其中。压缩检查点是一条普通 `user/message`（`region.ts:509`），它的 seq 大于所有被遮蔽节点。

有三个后果，都不影响正确性但都影响呈现：

**（a）早期轮次消失。** 聚合会自然地从「轮 1..N」变成「压缩点之后的轮次」。这不是 bug 而是正确反映——已被折叠进摘要的内容不该再占分轮预算。但最前面的轮次编号会跳号（只剩 `turns 7-9`），模型可能误以为前面的内容丢了。处理方式见 §7.1。

**（b）检查点自身会算进压缩发生的那一轮，让该轮显得异常大。** 检查点是当前轮 append 的，所以它的 seq 落在当前轮的区间里。一次 30k 的压缩会让「第 N 轮」显示成 30k+，而实际那一轮只有几次小调用。

这不算错——摘要确实占了那么多预算，模型需要知道——但它会误导「该压哪一轮」的判断：模型可能认为第 N 轮很贵而它其实是压缩的账。**方案的选择是不做特殊处理**，理由：把检查点从轮次里摘出去需要额外规则解释「为什么这一轮的数字不含它自己刚产生的摘要」，而摘要确实是当前上下文的一部分。这一点必须写进读数的文档，否则未来维护者会当 bug 修。

**（c）`nodes` 数组在压缩后不再是 seq 有序的。** `applySurfacePlan`（`surface.ts:570`）用 `state.nodes.splice(startIdx, count, plan.seq)` 把检查点塞进**被遮蔽区间的起始位置**，而它的 seq 比后面那些节点都大。所以数组位置与 seq 顺序不一致。

这条对方案的影响：按 seq 二分查轮次仍然正确（每个节点用自己的 seq 独立判定），但**任何假设「数组顺序 = 时间顺序」的写法都会错**。这也是 §4.3 选择「只记轮次起始 seq 再二分」而不是「按数组遍历切段」的原因之一。

## 5. 边界情形

| 情形 | 处理 |
|---|---|
| surface 上只有 0 轮（还没开始） | 不显示分轮（读数本身也不会发布） |
| 只有 1 轮 | 不显示（§3） |
| 压缩后只剩 1 轮 | 不显示——此时「分轮」又退化成总量 |
| 某轮在 surface 上没有节点 | 该轮不出现在列表里，不补 0 |
| `contextWindow` 未知 | 仍显示分轮（分轮不依赖窗口），只是没有百分比 |
| 读数被 `minDeltaRatio` 去抖跳过 | 不显示——去抖是整条读数级别的，分轮跟它一起沉默 |

## 6. 改动面

### 6.1 `pressure.ts`（纯函数，无新依赖）

```ts
interface TurnSize {
  readonly turn: number
  readonly tokens: number
}

interface ReadingInput {
  totalTokens: number
  contextWindow?: number
  format: ReadingFormat
  turns?: readonly TurnSize[]   // 新增；空或长度 1 时忽略
}
```

`renderReading` 追加一段 ` · turns 1-3: 2.1k 8.7k 31.4k`。`formatTokenCount` 复用，`precision` 与 `unit` 同时作用于这一段的数字（否则一条读数里两种精度会让人误判）。

**轮次编号的写法需要决定**（§7）。

### 6.2 `internal.ts`

`SessionReadingState` 加一个字段：`turnStarts: { readonly turn: number; readonly seq: SessionSeq }[]`。

用数组而不是 `Map`，因为要按 seq 二分；数组天然有序，且轮次数很小。

### 6.3 `index.ts`

- `session/event` 监听器里加：`if (event.type === 'turn/start') state.turnStarts = [...state.turnStarts, { turn: event.data.turn, seq: event.seq }]`。
- `observe()` 里把 `measurement.nodes` 按 `turnStarts` 二分聚合成 `TurnSize[]`，传给 `renderReading`。

**聚合函数放哪**：应放 `pressure.ts` 作为纯函数（`turnSizes(nodes, turnStarts): TurnSize[]`），因为它是可测的纯逻辑，且与渲染属于同一层。`index.ts` 只负责把两个数据源接上。

### 6.4 不需要改的

- 不新增 session event（`turn/start` 已存在）。
- 不新增 projection（guard 自己的状态是私有的、非持久的，`internal.ts` 的注释已声明「nothing here is model-visible or durable」；引入 projection 会把它变成持久化表面，还要处理 `stateVersion` 与旧状态迁移，代价与收益不成比例）。
- 不动 meter（`measurement.nodes` 已带 seq）。
- 不动 `compact_context`（那是第 2 步）。

## 7. 必须先决定的三件事

### 7.1 轮次编号：绝对还是相对

压缩后剩 `turns 7-9` 会让模型困惑「1-6 去哪了」。两个写法：

- **绝对**：`turns 7-9: ...`——与 `throughTurn` 的取值一致，模型可以直接用它填参数。
- **相对**：`last 3 turns: ...`——不会跳号，但模型无法表达「压到第 5 轮」。

**我倾向绝对**，因为第 3 步的存在意义就是让模型能指名某一轮。跳号的困惑应该由说明解决（压缩后的读数已经在讲压缩这件事），而不是靠换一套编号。

### 7.2 长会话的截断

轮次数超过阈值时怎么办。三个选项：

- 只列最近 N 轮，前面写 `earlier: 12.3k`——保总量可加性（各段之和=总量），但模型看不到前面各轮的分辨率。
- 只列最近 N 轮，省略部分标注 `+8 turns`——简短，但数字不可加。
- 全列——最诚实，但长会话读数会很长。

**我倾向第一种**：可加性是模型做判断的基础，而 `earlier: 12.3k` 正好回答「前半段值得压吗」。

阈值应该是 Config 字段（仓库规则禁止 hardcoded tunables），默认值需要测。

### 7.3 数字长度对模型的实际成本

一条 `turns 1-30: 2.1k 8.7k ...` 会有 100+ 字符，每步都发。需要一个 Token 成本估计：

- 30 轮 × 约 6 字符 ≈ 180 字符 ≈ 50–60 tokens/读数。
- 100 步会话 ≈ 5–6k tokens 总额外成本。

这个量级与当前读数（约 15–30 tokens）相比是 2–3 倍，是否可接受需要用户判断。**这也是 §7.2 必须截断的真正理由**。

## 8. 测试

### 8.1 纯函数（`pressure.spec.ts`）

- 4 种渲染形态 × 有/无窗口（§3 表格）。
- `turnSizes` 的聚合：单轮、多轮、某轮无节点、seq 不在任何区间内。
- 空 `turns` 与长度 1 的 `turns` 都渲染成现状形态（这是 163 个快照的保证）。
- `precision` / `unit` 对分轮数字同样生效。

### 8.2 插件（`plugin.spec.ts`）

- 单轮会话不显示分轮（防止回归到 §2 的爆炸）。
- 多轮会话显示分轮，且数字与实际轮次对应。
- `minDeltaRatio` 去抖时整条读数不发布（分轮跟着沉默）。
- 压缩后轮次编号跳号时的渲染。

### 8.3 快照

只有 4 个（§2）：`snapshots/sdk/subagent-fork-in-process`、`snapshots/sdk/subagent-list-agents`、`snapshots/sdk/subagent-mixed`、`snapshots/sdk/tool-scheduler-recovery`。

全部重录后逐个核对：分轮数字之和应等于（或接近）该读数的总量，不等的原因是工具 schema 与 system prompt 的固定开销不归属任何轮——这一点要在断言里写清楚，否则未来维护者会以为是 bug。

**一个必须注意的时序事实**：读数是在 post-execute 里测的，此时本步的工具结果**尚未**提交到 surface（`index.ts:222` 的 JSDoc 已说明「the current call's result is not yet committed」）。所以最后一轮的数字会偏小约一次调用输出。这不是分轮引入的问题（总量本来就低估），但分轮会让它显形：总量与各轮之差的缺口会比预期大。测试断言不能用「必须完全相等」。

另一个实测细节：`snapshots/sdk/tool-scheduler-recovery` 的两条读数**字数完全相同**（都是 `[context: ~5.9k tokens]`），因为第一轮结束时与第二轮开始时的 surface 占用没有变。这条快照会变成两条带不同分轮的读数（第 1 条只有轮 1，第 2 条有轮 1-2），是验证「第 2 条才该出现分轮」的最好素材。

### 8.4 反证

照既有做法，每个新测试都要做反证：
- 去掉「≥2 轮才显示」→ 单轮测试必须失败。
- 把聚合改成按日志顺序而非 seq 区间 → 多轮测试必须失败。

## 9. 我还不确定的事

1. **§7 三个决定都需要用户拍板**，尤其是截断策略，它直接决定读数成本和可加性。
2. **「turns」这个措辞是否合适**。它是英文，读数本身是英文（`[context: ...]`），但模型面对 `turns 1-3` 与面对 `throughTurn` 参数名的一致性需要确认。
3. **没有实测证据说明分轮大小能改善压缩选择**。第 3 步的收益是推理，不是测量。这和 Note 的 §Risks 最后一条同构。
4. **分轮数字与总量的差额**：工具 schema、system prompt、`<compacted-summary>` 检查点自身都占预算但不属于任何轮。读数里这两组数字对不上，模型可能困惑。是否要显式列出 `overhead: X` 需要决定——列了更诚实但更长。

## 10. 实现记录（落地后的差异）

按用户 m07779 的拍板实现：绝对轮号、只列最近 N 轮加 `earlier`、不显式列 overhead。落地后与本文的差异：

1. **§8.3 的「4 个多轮快照要重录」没有发生**。四个场景重放后仍通过，读数仍是无分轮的短形态。原因：这些会话虽然在多轮里产生了读数，但 `turnSizes` 只统计**仍在 surface 上**的节点，而它们在第 2 轮时 surface 上只剩一轮的内容（前期内容已被压缩或被 replace 遮蔽）。所以「跨轮」不等于「surface 上有两轮」——这是实现后才显形的事实，也是 §2「先问什么时候不显示」这一判断的正确性来源。
2. **§8.4 的反证做了三处**，全部通过：去掉 `turnSizes` 调用 → 2 条测试失败；不记录 `turn/start` → 同样 2 条失败；两处分别反证覆盖了「数据来源」与「渲染分支」两半。
3. **§9 第 4 条（分轮数字与总量对不上）在实现里没有变化**：`turnSizes` 只聚合测得的节点价，system prompt、工具 schema 与压缩检查点的固定开销不归属任何轮，差额仍然存在。按拍板不显式列出。
4. **`maxTurnsInReading` 的校验**落在 `resolveFormat`，非整数或负数在加载时抛 `context-pressure-reminder: invalid maxTurnsInReading <value> — must be an integer >= 0`，与其余配置字段同一处、同一风格。
