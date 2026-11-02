# Agent Note: 由模型选择压缩区间

Status: proposed

[English](2026-11-02-model-chosen-compaction-range.md) | 中文

## 问题

`compact_context` 告诉模型存在压缩这件事，却不让它对压缩做任何选择。工具只收 `focus`，而 `serveModelRequest` 写死 `selectCompactableRange(session, pruned, 0)`，于是「折叠哪一段、留多长的尾巴」完全由后端决定。模型知道自己正承压，却无法说明该舍弃什么。

CLM 关于编辑经济性的论证值得在这里吸收，但它的机制不行。它的机制是把上下文镜像成一个模型可改写的文件，这在 DSH 里不可用：`packages/core/session/src/surface.ts` 要求 `surfaceOp: replace` 的区间重写只能通过 `content` 改 `tool/result` 节点，并为每个被遮蔽的 seq 带上 `sourceEventSeqs`（`assertToolResultRewrite`），因此自由文本编辑会丢掉 tool-call/result 配对，使 Anthropic 与 Bedrock 形态的后端直接拒绝该请求。

在这个约束下仍能保留的部分更窄，却依然有用：**「在哪里切」这个决策交给模型，合法性、预算与闸门留在 harness。** CLM 写进它提示词里的经济性——一次大批量压缩优于多次小编辑，且一次早期的微小编辑要以重读其下方全部内容为代价——描述的正是模型当前无法做出的选择。

`focus` 曾是同一缺口的第二个实例，已单独修复：`SummarizationInput` 现在携带它，`summarizeWithLlm` 把它作为第二个 content block 追加在未改动的指令之后。那次修复确立了本提案要扩展的形状——请求抵达摘要器，而后端保留关于合法性的决策。

## 提案

给 `compact_context` 增加两个互斥的边界参数，并在后端把它们解析为表面区间。

### 接口变更

`packages/compaction/tool-compact/src/index.ts` 在 `focus` 之外增加两个可选整数参数：

| 参数 | 含义 |
|---|---|
| `throughTurn` | 压缩至第 N 轮结束，包含该轮完整的 tool 配对。 |
| `keepRecentTurns` | 保留最近 N 轮不动，压缩其之前的全部内容。 |

两者同时设置是工具层错误；都不设置则维持当前行为。用轮而不是 seq，因为模型天然按轮计数，且看不到表面位置——CLM 以 `[[CTX_TURN i]]` 为锚点也是同样的理由。

`packages/compaction/tool-compact/src/request.ts` 的 `CompactionRequest` 增加 `boundary` 字段，`readFocus` 改为 `readRequestArguments`，一次解析出 `focus` 与 `boundary`。非法值折叠为「未指定」而不抛错，与既有注释一致：注册表已经校验过参数，这个 fold 不应发明第二套校验权威。

### 解析

在 `packages/compaction/compaction-basic/src/region.ts` 新增一个纯函数：

```ts
export function planRequestedRange(
  session: Session,
  boundary: RequestBoundary,
): { start: SessionSeq; end: SessionSeq } | RequestBoundaryRefusal
```

`serveModelRequest` 在 `selectCompactableRange` 之前分支：没有边界走现有调用，有边界走 `planRequestedRange`。

把轮解析成表面区间需要一次日志折叠，因为 `user/message` 不带轮号（`packages/core/session/src/types.ts:315`），而 `turn/start`（`:294`）、`assistant/message`（`:349`）、`tool/call`（`:369`）、`tool/result`（`:383`）都带。折叠从 `turn/start` 取每轮的起始 seq，取该轮最后一个 `tool/result` 或 `assistant/message` 作为结束 seq，再上溯到最近一个 `toolPairingBalancedAfter` 边界。`pendingCompactionRequest` 已经在扫描日志，因此轮次表随该次扫描一并收集，不触发第二次扫描。

`gate.ts` 现有的 `RequestBoundaryRefusal` 增加三个成员：`turn-not-found`（请求的轮超出会话）、`turn-too-early`（该轮没有任何已完成表面节点）、`range-unbalanced`（解析出的边缘切开了配对）。每个都需要一条 `renderRefusal` 文案给出可执行指示，`assertNever` 兜底保留。

### 尾部保留

`retainTokens` 与 `keepRecentTurns` 表达不同预算且可能冲突：最近三轮可能只有 500 token，也可能有 60,000。`retainTokens` 未设置时甚至不是常数——`config.ts:248` 按 `Math.floor(messageBudgetTokens * policy.retainRatio)` 推导，`DEFAULT_RETAIN_RATIO = 0.16`（`config.ts:24`）。当模型给出边界时以模型为准，`retainTokens` 降为 0——与模型请求路径当前已传的值相同。后端默认值不得悄悄否决显式请求。该约定由 `planRequestedRange` 的文档承载。

其余自动路径均不变：`compactPressure` 保持 `selectCompactableRange(..., spec.retainTokens)`，`compactIfNeeded('context-overflow')` 保持 `(..., 0)`，不带边界的请求保持 `(..., 0)`。新逻辑只在显式给出边界时运行，因此 `snapshots/session/context-compact-tool/` 保持逐字节不变。

### 无需改动的部分

收缩闸门已经覆盖模型选定的区间。`region.ts:423` 在同一事务内拒绝不比被遮蔽内容严格更小的摘要，对任意来源的区间一视同仁。阻止模型把上下文撑大，正是 CLM 需要专门写一道闸门而 DSH 已经做掉的那件事。

`compactRegion` 的签名同样不变：`focus` 已经确立，只有单一策略能产生的请求通过事务选项传递，而不是通过抽象方法。

## 实施顺序

| 步 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| 0 | 把 `focus` 送达摘要器 | 无 | 低——一个可选输入 ✅ 已交付 |
| 1 | 给读数加上分轮大小 | 读数 | 中——模型可见文本，需全量刷新快照 |
| 2 | `keepRecentTurns` 加 `planRequestedRange` | 1 | 中高——新拒绝理由、快照、测试矩阵 |
| 3 | `throughTurn` | 2 | 视第 1 步的效果决定 |

第 2 步是 CLM 那套编辑经济性文案获得约束对象的时刻：只有到那时，模型才能在「一次压十轮」与「分五次各压两轮」之间权衡。

轮折叠读取会话日志，因此继承 `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md` 记录的 `snapshotEvents()` 弃用。现有两处调用点带着豁免。新增调用点需要同样的豁免并写明理由，或迁移到 `eventAt`/`ownEvents`；这个选择属于实现，不属于本记录。

## 备选方案

- **自由形式上下文编辑**——已否决：`assertToolResultRewrite` 禁止这种行为，而它导致的 tool-call/result 配对丢失会被 provider 的请求校验拒绝。CLM 的代价是把历史重建为仅含角色与文本；DSH 的表面层在设计上更强。
- **工具参数里使用基于 seq 的区间**——已否决：模型看不到表面位置，也无从获知。轮是它已经在计数的单位。
- **第一版就做 `throughTurn`**——已延后：它要求模型知道每一轮的大小，而随 `compact_context` 一起加入的读数只报总量。`keepRecentTurns` 从尾部往前数，那是模型判断可靠的方向。等读数带上一轮尺寸再重新考虑。
- **扩展 `CompactionEngine.compactRegion` 使其接受请求**——已否决：抽象方法是「自有区间」调用方的接缝，而只有单一策略产生的边界不属于 Service Definition。
- **复用 `retainTokens` 表达 `keepRecentTurns`**——已否决：token 预算与轮预算不可互换，把其中一个折算成另一个会用启发式掩盖模型的明确意图。
- **后端把解析出的边界调成「更安全」的位置**——已否决：静默调整会让模型的请求与实际压缩不一致，而模型无从察觉。应当以可执行的理由拒绝。

## 验收标准

- 带 `throughTurn` 的 `compact_context` 折叠至指定轮结尾的每个表面节点且不含其后内容；带 `keepRecentTurns` 时恰好留下指定尾部。同时设置两者在工具层失败，并给出点明冲突的消息。
- `planRequestedRange` 把轮映射为配对平衡的区间，或返回对应拒绝；每条拒绝都作为可执行提示抵达模型，且 `assertNever` 仍覆盖该封闭集合。
- 边界指向超出会话的轮、无已完成内容的轮，或会切开配对的边缘时，产生对应拒绝且表面保持不变。
- 收缩闸门对模型选定区间的膨胀摘要的拒绝方式，与对自动选定区间完全一致。
- 不带边界的请求产生与今天逐字节相同的 `compact_context` 行为，因此既有快照保持不变。
- keyless 录制会话快照覆盖一次指定边界的压缩、一次 `keepRecentTurns` 压缩，以及一次拒绝；读数本身的超集行为由既有场景继续覆盖。
- `docs/tool-catalog.md`、`config-catalog`、`event-producer-consumer` 与各包 README 在同一次改动中重新生成；`packages/compaction/tool-compact/README.md` 记录两个参数及其互斥性。

## 风险

- **模型可能选得比后端差。** `selectCompactableRange` 知道每个节点的 token 数（`measurement.nodes[].tokens`），模型只知道总量。折叠一段便宜的早期内容、而真正占预算的是对话中部一次巨大结果，是可能的失败形态；读数的分轮尺寸是缓解手段，而不是本次交付的内容。CLM 通过暴露每一轮的大小来回答这个问题（`[[CTX_TURN]]` 头加每个结果的大小）；DSH 的读数只报一个总量。
- **`keepRecentTurns: 1` 处的歧义。** 若最近一轮持有未闭合的 tool 配对，该边界没有合法位置。本提案选择拒绝（`range-unbalanced`）而不是调整，因为调整过的边界意味着模型请求的内容与实际压缩的内容不同，而模型无从从结果中察觉。拒绝提示必须点出真正可行的边界。
- **不规则历史形状抵达 provider。** 保留早期若干轮却压缩中部一段，会产生自动路径从不制造的历史排布。既有 `compactRegion` 本来就产生不同区间，所以这不是新的风险类别，但需要真实 provider 的 e2e 而不是推断。
- **两种模型无法据以行动的拒绝。** `turn-too-early` 与 `range-unbalanced` 可能都在描述一个模型自认为完整的轮。反复拒绝会各浪费一步；提示必须点出真正可行的边界。
- **没有测量表明模型选边界优于后端。** CLM 报告的数字来自其完整机制之上的端到端 agent benchmark，而不是单独的区间选择。本提案是能力论证，应当以它是否产生更好的压缩来评判，而不是继承那些数字。
- **`focus` 仍无长度上限。** 模型可以把数千 token 的 `focus` 写进摘要请求。`StringValueSchemaSpec` 没有 `maxLength`，因此约束它属于执行层而非 schema，本次不处理。
