# 设计方案：`packages/guard/context-pressure-reminder/`

> 对应 [clm-to-dsh-portability.md](clm-to-dsh-portability.md) 第 ① 条（模型可见的上下文读数）。
> **本文只是方案，没有改任何代码。**
> 文中每个结论都注明了源码位置；凡是我无法从现有 API 做到的，明确标「需要先改 X」。

---

## 0. 目标与非目标

**目标**：让模型在每次工具调用后知道「当前上下文多大 / 窗口多大 / 百分比」，从而能主动收敛，而不是全程盲飞直到硬压缩。

**非目标**：
- 不做分级 nudge（第 ② 条，独立插件）；
- 不做压缩闸门（第 ③ 条，落在 `compactRegion`）；
- 不改 `compaction-basic` 的判定逻辑；
- 不新增 Client 组件、不新增 session event（理由见 §3 / §7）。

---

## 1. 结论先行

| 问题 | 结论 |
|---|---|
| 需要新增 session event 吗？ | **不需要。** `additionalContexts` → `agent/inbox/spliced` → `user/message` 这条链已经承诺「model-visible ⟺ logged」 |
| 用哪个 hook 注入？ | `tools/post-execute`（**不是** `agent/post-execute`，后者不存在），返回带 `additionalContexts` 的 `PostToolDecision` |
| 读什么数据？ | `ctx.tokenMeter.measure(session).totalTokens` + `session.requestContext()?.contextWindow` |
| 和 `compaction-basic` 的 0.8 阈值怎么协调？ | 本插件**不读阈值、不复制阈值、不判断越线**。只报绝对值和百分比；「已压缩 / 正在压缩」由观测 `compaction/start`\|`end` 事件得出 |
| 要哪些测试？ | 纯函数单测 + `ctx` 级行为单测 + 一个 real-composition 测试 + 一个 keyless 快照 |

---

## 2. 包结构

按 `packages/guard/repeat-tool-reminder/` 1:1 平移（该包只有 `src/index.ts` + `src/invariant.ts` 两个源文件，非常轻）：

```
packages/guard/context-pressure-reminder/
├── package.json            # @deepseek-ai/dsh-context-pressure-reminder
├── tsconfig.json
├── tsdown.config.ts
├── README.md / README.zh.md / README.i18n.yaml   # 按 docs/AGENTS.md
├── src/
│   ├── index.ts            # name / inject / Config / apply
│   ├── invariant.ts        # `./invariant` 导出
│   ├── pressure.ts         # 纯函数：格式化 + 是否该输出（无 ctx，可单测）
│   └── internal.ts         # 每 session 的去重状态类型
└── tests/
    ├── pressure.spec.ts
    ├── plugin.spec.ts
    └── composition.spec.ts
```

**`invariant.ts` 是一个空注册，照抄模板。** `repeat-tool-reminder/src/invariant.ts` 的实际内容就是 `const install: InvariantInstaller = () => {}`，注释写明理由：「repeat chain 是单个 post-execute 监听器的私有时序，不暴露任何包拥有的、独立 companion 可观测的事件或快照」。本插件同理：它的状态是 `WeakMap` 里的去抖计数，没有包拥有的 durable 事件可断言。**不要**为了「显得规范」硬造一条 invariant —— `packages/AGENTS.md` 明确说「没有可信的关系时，一个解释清楚的空 companion 才是对的」。

---

## 3. 注入机制（逐跳给源码）

### 3.1 事件链

```
ToolRuntime.postExecute                    packages/core/tools/src/index.ts:1736
  └─ waterfall('tools/post-execute', exec, result, next)      :1743
       ← 本插件在这里
       └─ decision.additionalContexts                         :1746
            └─ 合并进返回的 ToolExecutionResult.additionalContexts   :1759-1778

executeToolCalls → runGroup → commitReady  packages/core/agent-loop/src/tool-calls.ts:156
  └─ for (const context of result.additionalContexts ?? []) acceptContext(context)

acceptContext                              packages/core/agent-loop/src/agent.ts:432
  └─ this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context])

Inbox.mutate                               packages/core/agent/src/inbox.ts:186
  └─ this.session.append('agent/inbox/spliced', splice)      ← 落盘，durable

下一个 step 的 preStep → inbox.claim()      packages/core/agent-loop/src/agent.ts:236
  └─ 进入 decision.messages
       └─ session.append('user/message', message, { surfaceOp: 'append' })   :290
```

**关键结论**：读数消息最终是一条**普通 `user/message` 的 surface append**，全程有 durable 记录（`agent/inbox/spliced` + `user/message`），不需要新事件，也不需要 `sourceEventSeqs` 指回 `tool/result` —— 这个指回是 `spill` 之类改写既有节点的场景才需要的；我们是新增节点。

### 3.2 五条硬约束

1. **必须 `await next()` 并委派。** `tools/post-execute` 是 waterfall，不调用 `next()` 会短路后续监听者（`AGENTS.md`：Waterfall listeners MUST call `next()`）。`repeat-tool-reminder` 的写法是「先算、再 await next()、最后合并」，照抄。

2. **`block` 和 `accept` 两个分支都要合。** `PostToolDecision` 有两个形态，两条都要把 `additionalContexts` 前置合并（`repeat-tool-reminder/src/index.ts:213-224` 的 `prependContext`）。工具失败（`isError`）时 `additionalContexts` **仍然有效** —— 与 `notes` 之类的东西无关，`ToolExecutionResult` 根本没有 `notes` 字段（`packages/core/tools/src/index.ts:557-577`）。所以失败步也能附读数，这是好事。

3. **不阻塞、不改写。** 只加 `additionalContexts`，不返回 `block`，不改 `content`/`value`。

4. **位置顺序天然安全。** `additionalContexts` 先进 `next-step` inbox，等**本步全部 tool result 提交完**才被 claim 成 `user/message`。所以它永远排在所有 `tool/result` 之后，不会插进 `tool_use`/`tool_result` 之间 —— 这是 Anthropic/Bedrock 400 的经典雷区，这里结构上不可能踩到。

5. **每个 step 只出一次。** 并行工具调用会让同一 step 内多次进 `postExecute`。用 `WeakMap<Session, { remindedForStep: number | null }>` 去重，配合监听 `session/event` 的 `step/start` 复位。**不能用**「每 N 步」这种计时器：读数必须与上下文实际变化对齐。

### 3.3 读数文本（草案）

```
[context: ~48.2k/128k tokens · 38%]
[context: ~112.0k/128k tokens · 88% · compacted 3 steps ago]
[context: ~51.3k/128k tokens · 40% · ~61k reclaimed]
[context: ~48.2k/128k tokens]                          # contextWindow 未知时
```

- `~` 保留 CLM 的「估算」语义，避免模型把数字当精确值去做算术；
- 百分比整位取整，token 用 1 位小数 + `k`（`Config.format` 可改）；
- 「刚压缩」「几步前压缩过」来自观测 `compaction/end` 事件，不是推测；
- **刻意不写「正在压缩」**：本插件在 `post-execute` 跑，而 `compaction-basic` 在 `agent/pre-step` 跑（`compaction-basic/src/index.ts:165-181`），两者时序上不会看到对方的中间态。

---

## 4. 与 `compaction-basic` 的 0.8 阈值协调

这是最容易做错的部分，单独成节。

### 4.1 三条规则

1. **不读 `thresholdRatio`。** 它是 `compaction-basic` 的 Config（`compaction-basic/src/types.ts:12`），复制到第二个包就会出现「改一处另一处不生效」。
2. **不自己算「越线」。** 部署方可以把阈值调成 0.6 或 0.92（`DEFAULT_THRESHOLD_RATIO` 不是契约），本插件算的「越线」会和真实行为对不上，然后模型收到一条撒谎的提示。
3. **本插件永不触发压缩。** 只输出一行字。压缩的唯一执行者仍是 `compaction-basic`，结构上不可能造成 double-compact。

### 4.2 阈值确实不可见（诚实说明）

我核对了 `compaction` 的 Service Definition 全文（`packages/compaction/compaction/src/index.ts`），公开面只有：
`compactIfNeeded` / `compactNow` / `compactRegion` / `onRound(hook)`。

- **没有**「当前阈值是多少」的只读方法；
- **没有**「是否已排了压缩」的只读查询；
- `measure` 的 `TokenMeasurement` 里也没有阈值（`packages/llm/token-meter/src/types.ts` 只给 `totalTokens`/`surfaceTokens`/`baseline`/`nodes`）。

所以 §3.3 里**不出现「over threshold」字样**。如果确实要它，两条路：

- **方案 A（推荐，但属于独立改动）**：给 `CompactionEngine` 加一个只读投影，例如
  `abstract pressureState(agent): { thresholdTokens?: number; compacting: boolean }`。
  这是 Service Definition 扩展，按 `AGENTS.md` 要同 PR 更新 `docs/architecture.md` 并加 invariant。
- **方案 B（不改 Service Definition）**：用 `onRound(hook)` 观测轮次 + `compaction/start`\|`end` 事件做本地状态机，推出「刚压缩完 / 正在压缩 / 距上次压缩用了多少」。**这仍然拿不到阈值**，所以只能说「已压缩」，不能说「越线」。

**建议**：PR-1 走方案 B 里能确定的那部分（已压缩/回收量），把「越线」留给方案 A 作为后续增量。第 ① 条的全部价值——模型知道自己在哪——已经达成。

### 4.3 观测点确认

`compaction/start`、`compaction/end` 都是已注册的 `SessionEventMap` 成员（`packages/core/session/src/known-event-types.ts:29-31`），插件可以直接 `ctx.on('session/event', ...)` 监听，不需要 compaction 包暴露任何东西。`compaction/end` 上带有压缩前后的 token 计数（`compaction-basic/src/region.ts:530` 注释明确说 after-price 在 `compaction/end` 上），正好用来算「回收了多少」。

---

## 5. Config（全部可从 cordis.yml 改）

```ts
interface Config {
  /** 是否附加读数；false 时插件完全静默（连日志都不写）。默认 true。 */
  enabled: boolean
  /** 数值格式。默认 { precision: 1, unit: 'k' }。 */
  format: { precision: number; unit: 'k' | 'raw' }
  /**
   * 只有 totalTokens 相对上次提示的变化占比达到该值才重新提示；
   * 0 表示每步都提示。默认 0.02。
   */
  minDeltaRatio: number
}
```

`minDeltaRatio` 的 0.02 是对付「模型连跑 20 个小 `ls`」的场景：每步给一模一样的读数纯属浪费（一条约 15–30 token，100 步约 2k token，不是免费）。设为 0 可每步都给（调试用）。

**没有 hardcoded tunable**：阈值不从本插件来（§4.1），格式与频率都是 Config 字段。

---

## 6. 刻意不做的两件事

1. **不算「还剩几步 / 还能跑多久」。** CLM 的 `budget.py` 有 `adaptive` 模式按最近 3 次输出估余量。DSH 的 `packages/core` 里没有 step/turn 上限的概念，余量无从算起；未知输出长度的估算会引入噪声，模型容易据此误判。
2. **不复述历史内容。** 那会自己跟自己抢上下文。

---

## 7. Client 面：为什么不需要改

读数最终是一条**普通 `user/message`**（§3.1），前端按普通消息渲染：

- 不涉及 locale 字典，`verify-client-ui-i18n` 不会因此报错；
- 代价：Web 上看不出「这是系统附注」，和普通 steer 消息视觉一致。可接受 —— CLM 的读数本来也是工具输出附加行，不是独立 UI 组件。

若要视觉区分（灰底小字），走「result metadata + Web 卡片」的独立改动，不与本插件耦合。

---

## 8. 测试与快照

### 8.1 单元测试

| 文件 | 断言什么 |
|---|---|
| `pressure.spec.ts` | 纯函数：四种措辞；`precision`/`unit` 格式化；`minDeltaRatio` 去抖（< 阈值不出、跨阈值必出）；`contextWindow` 未知时降级为无百分比 |
| `plugin.spec.ts` | `await next()` 后被调用一次（委派不短路）；`block` 与 `accept` 两分支都带 `additionalContexts`；同一 step 多次 `post-execute` 只出一次（含并行工具）；`step/start` 后复位；`enabled: false` 零注入；`tokenMeter` 缺失时静默跳过（不抛）；失败工具（`isError`）也附读数 |
| `composition.spec.ts` | real composition：挂 `token-meter` + `compaction-basic` + 本插件，跑一轮真实工具调用，断言 `agent/inbox/spliced` 里出现该消息、且随后 `user/message` 以 `surfaceOp: 'append'` 落盘、`deriveEventMessage` 能取出它 |

`composition.spec.ts` 必须走 real composition：本插件赌的是「`additionalContexts` 能不能真的穿过 §3.1 那条链」，mock 掉就测不到这个契约。

### 8.2 快照

一个 keyless recorded-session 快照（顶层 `snapshots/`，归 snapshot 所有者，见 `snapshots/AGENTS.md`），覆盖：
1. 普通一步（读数出现）；
2. 连续多步（去抖生效，不是每步都出）；
3. 压缩发生后（出现 `reclaimed` 措辞）；
4. `contextWindow` 未知的路由（降级形态）。

这是**模型可见输出**的改动，快照是硬性要求。

### 8.3 其它门

- `pnpm run typecheck`、`pnpm run lint`；
- `verify-export-jsdoc`（`name`/`inject`/`Config`/`apply` 与导出的纯函数都要完整 JSDoc，含 `@param`/`@returns`）；
- 若在 bundle/example 里挂载，`verify-cordis-config`；
- `pnpm run hygiene`（knip 会检查新包的依赖是否真的被 import）；
- 一个 Agent Note：`.agents/notes/implemented/architecture/<date>-context-pressure-reminder.md`，记录「为什么走 `additionalContexts` 而不是新事件」「为什么不读 `thresholdRatio`」。

---

## 9. 落地顺序（建议三个 PR）

1. **PR-1 最小可用**：包骨架 + `pressure.ts` + `tools/post-execute` 注入 + 去抖 + 单测 + 快照（只报 `~N/M · X%`，不含压缩相关措辞）。这一版已交付第 ① 条全部价值。
2. **PR-2 压缩感知**：观测 `compaction/start`\|`end`，加「刚压缩/回收量」措辞 + 对应测试。
3. **PR-3 「越线」提示（可选，需先扩 Service Definition）**：按 §4.2 方案 A 给 `CompactionEngine` 加只读投影，再让本插件消费；同 PR 更新 `docs/architecture.md`。

---

## 10. 遗留不确定性（诚实清单）

1. **`minDeltaRatio` 默认 0.02 是拍的**，没有实测依据。PR-1 落地后应在真实长会话里看「每 50 步提示几次」再定。
2. **读数自身的 token 成本**：约 15–30 token/次，长会话累积约 2k。相对它可能省下的溢出重试（一次失败重试的成本远高于 2k）是合算的，但没有实测数据。
3. **多 provider 行为**：落成 user 消息而非 tool 消息，对 Anthropic/Bedrock 类后端安全（不与 `tool_use` 交错），但仍应在 PR-1 的 real-API e2e 里至少跑一次非 DeepSeek provider 确认。
4. **`inject` 声明的服务依赖**：本插件依赖 `tokenMeter`。若用 `inject: ['tokenMeter']`，未挂 meter 的部署会直接不加载插件（fail silent 而非 fail loud）。**建议不声明 `inject`，改为 `apply` 里 `ctx.get('tokenMeter')` 判空后 `ctx.logger.warn` 一次**，这样「装了插件但没装 meter」能被看见。
