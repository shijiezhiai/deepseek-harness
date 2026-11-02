# PR-2 设计：递增式提醒阶梯（context-pressure-reminder）

> 上游依据：`clm-to-dsh-portability.md` 第 ② 条
> 前置：PR-1（读数注入，`packages/guard/context-pressure-reminder/`）已落地
> 日期：2026-10-28
> 结论先行：**建议只搬 CLM 阶梯里的一档，而不是 25/50/75 三档。**

---

## 1. CLM 原来的阶梯，以及 DSH 为什么不能照抄

`clm_harness/utils/budget.py` 的 `BudgetController.evaluate()` 是三层结构，不是简单的「按比例提醒」：

| CLM 层 | 触发 | 语义 |
|---|---|---|
| 阶梯 nudge | `nudge_ratios`（25/50/75%），每档**只触发一次**，回落后再武装 | 「你还早，但可以考虑收敛」 |
| 持续 nudge | `persistent_nudge_ratio`，或 `adaptive`（按最近 3 个 tool output 的最大值定带宽，下限 10%、上限 50%） | 「每轮都提醒，直到你真的降到线下」 |
| 越限 | `strict_target = budget - reserve`，回滚最新 turn + 逼一次压缩，最多 `max_num_retry_on_limit` 次 | 终局兜底 |

**DSH 不能照抄的三点，逐条对应到源码：**

1. **DSH 没有「越限即结束」这件事。** CLM 的阶梯之所以有意义，是因为越限的后果是「一次 final turn 然后结束」，所以 25/50/75 是模型仅有的三次自救机会。DSH 越限由 `compaction-basic` 处理——`packages/compaction/compaction-basic/src/index.ts:165-183` 在 `agent/pre-step` 里 `await this.compactIfNeeded(agent, 'pressure', signal)`，越限还有 `agent/request-error` 的 overflow 重试（`:197-207`，`maxOverflowRetries` 默认 1，`config.ts:93`）。**DSH 的越限不是死亡，是自动换血。** 照抄阶梯等于在一条有安全网的路上画三段越来越急的黄线。

2. **50% 这一档在 DSH 里是错的时机。** DSH 的自动压缩阈值是 `thresholdRatio` 默认 0.8（`compaction-basic/src/config.ts:74`）。在 50% 处提醒模型「你该压缩了」，而此时 `compactIfNeeded` 根本不会被触发、`/compact` 又要用户自己敲，模型**没有任何能立刻执行的压缩动作**——提醒变成噪音。CLM 能这么提醒，是因为模型手里就有编辑上下文文件的权力。

3. **三档文案在长会话里会退化成背景噪音。** DSH 的会话动辄上百步，25/50/75 各一次意味着模型在它还完全不需要担心的阶段被三次打断。CLM 用一次性 + 「armed」状态来控频，但 DSH 的读数（PR-1）已经在每步稳定给出百分比了——**模型看得到 47%，一句「现在 47%，注意点」的信息增量接近于零。**

---

## 2. 建议搬的那一条：danger-band nudge

CLM 三层里真正有增量的是中间那层，而且它有一个 DSH 特别需要的性质：**它不是固定比例，而是按「下一个 observation 会有多大」定带宽。**

CLM 原文（`budget.py:232-258`）的思路是：

```
need = max(10% of limit,  2.0 × 最近 3 个 tool output 里最大的那个)
band  = limit - need
带宽命中条件：strict_target - tc < need
```

理由写在 docstring 里，而且是这整段代码里唯一真正来自经验的一句：**「固定带宽在某次输出比带宽还宽的时候必然失手——上下文会从线下直接跳过线。」**

这句话原样适用于 DSH。DSH 的 `compaction-basic` 是在 `agent/pre-step` 检查的，也就是说：**它只在上一步结束后检查一次。如果一个工具结果把上下文从 70% 一步顶到 95%，`compactIfNeeded` 会在下一步补上——但如果顶到 105%，模型先吃一个 overflow、压缩、重试**（`:197`，默认只重试 1 次）。这正是 CLM 说的那种失手。

所以 PR-2 的范围是：**把固定比例的「危险带」换成按最近 observation 尺寸自适应的危险带**，在带宽内每步提醒一次，直到离开。

### 文案长什么样

PR-1 的读数已经有百分比了，nudge 不该重复它，而该说**它不知道的那部分**：

```
[context: ~86.1k/128k tokens · 67% — a large tool result can still overshoot this; prefer finishing a unit of work and writing findings to a file]
```

关键在于「a large tool result can still overshoot this」这句——它讲的是带宽，不是占用率。这一句是 CLM 那条经验的直接翻译：模型此时需要知道的不是「我多少」，而是「**我还没到线，但下一个大输出就能把我送过线**」。

### 边界怎么算

```
recentObservation = 最近 3 个 tool/result 的 measure() 最大值
need = clamp(2.0 × recentObservation, 0.10 × remaining, 0.50 × remaining)
dangerBand = contextWindow − need
```

- 下限 10%：输出都很小时退化成「90% 规则」，和常识一致。
- 上限 50%：一次巨型输出不会让 nudge 从 50% 就开始一直响。
- `2.0 ×` 是 CLM 的 `persistent_nudge_obs_mult` 默认值，**但 DSH 这边必须有实测才能确定**，见 §6 的不确定性。

**这个带宽不依赖 `thresholdRatio`**——它只依赖 `contextWindow` 和最近输出大小，两者 PR-1 都拿得到（`session.requestContext()?.contextWindow` 和 `tokenMeter.measure`）。所以 PR-2 **不需要**动 `CompactionEngine` 的 Service Definition。（需要那个的是 PR-3，见 §5。）

---

## 3. 注入点：为什么是 `agent/pre-step` 而不是继续用 post-execute

PR-1 走 `tools/post-execute` + `additionalContexts`，因为读数是对**刚发生的事**的注解。nudge 不是。

`packages/core/agent-loop/src/agent.ts:241-249`：

```ts
const decision = await this.dispatch.waterfall(
  'agent/pre-step', { messages: claimed, ...position, signal },
  () => Promise.resolve<PreStepDecision>({
    kind: 'enter',
    messages: context === undefined ? claimed : [...claimed, context],
  }),
)
```

`time-context`（`packages/context/time-context/src/index.ts:170-208`）就是标准写法：`await next()`，然后 `{...decision, messages: [...decision.messages, 新消息]}`。`session-reference`、`agent-instructions`、`tool-skill`、`plan-mode` 全是这个形状。

选 pre-step 的三个理由：

1. **时机对。** 「下一个输出可能把你顶过线」是对**即将发出的请求**的陈述，只能在请求之前说。写在 post-execute 里，它描述的就是上一个请求。
2. **频次可控。** 「带宽内每步提醒」天然是 pre-step 的语义；post-execute 每步每工具各触发一次，配上一个「每步一次」的去重才勉强等价。
3. **和 `compaction-basic` 是同一条链，顺序可以由组合决定。** 两者都听 `agent/pre-step`。`compaction-basic` 在 base bundle 里注册在前（`packages/bundle/base/cordis.patch.yml:326` vs guard 在 `:443`），waterfall 按注册顺序执行——**所以 nudge 看到的是压缩之后的占用**。这是我要的顺序：压缩完还剩 67% 才值得提醒；压缩前 85% 提醒了也没用，因为压缩会把问题解决掉。

第 3 点值得单独强调，因为它是易错的：如果 guard 用 `{ prepend: true }` 注册，它会跑在压缩**之前**，就会对着一个马上要被压缩掉的数字发警告。

### 一个必须守的次要约束

`agent/pre-step` 的 decision 只有 `{kind:'reject'}` 和 `{kind:'enter', messages, startsRequestSeries?}` 两个变体（`packages/core/agent/src/runtime-types.ts:56-62`）。**`reject` 必须原样透传，不能往里塞消息**——reject 的语义是这一步不进入模型调用，塞消息既无意义又会破坏 `agent.ts:274-284` 的「reject 结束 turn」判断。`time-context` 已经在 `:175` 做了这个检查（`if (decision.kind === 'reject' || signal.aborted) return decision`），照抄即可。

---

## 4. 状态与去重

PR-1 用 `WeakMap<Session, SessionReadingState>` 记 `publishedTokens` 做去抖。PR-2 需要多记两样：

```ts
interface NudgeState {
  /** 上一次真正发出 nudge 时的占用；离开带宽即清空。 */
  announcedAt?: number
  /** 最近若干次 tool/result 的 measure() 值，只保留窗口内的。 */
  recentObservations: number[]
}
```

规则：

- **离开带宽 → 清空 `announcedAt`。** 这样再进带宽会重新提醒（CLM 的 re-arm）。
- **在带宽内且 `announcedAt` 已存在 → 不再提醒**，除非占用又涨了 `minDeltaRatio` 以上的相对幅度。否则模型每步都会收到一句只差几十 token 的话。
- **`recentObservations` 只在 `session/event` 的 `tool/result` 上追加**，用 `tokenMeter.measure` 对单条消息计价（PR-3 的实现细节见 §5，因为这里有个坑）。

`minDeltaRatio` 直接复用 PR-1 的 Config 字段，不新开一个——它们回答的是同一个问题「多少变化才值得开口」。

---

## 5. 顺带发现的真问题：DSH 缺一个模型可用的压缩入口

这是我在核对 pre-step 时确认的，和 PR-2 的文案强相关，必须写进来。

`packages/compaction/command-compact/src/index.ts` 是 `/compact` 的完整实现，但它是 **command**——`CommandInvocation` / `CommandResult`，面向人的斜杠命令。全仓 `grep` 下来**没有任何一个 tool 暴露 `compactNow` / `compactRegion`**。

后果：PR-1/PR-2 的提醒说「prefer finishing a unit of work and writing findings to a file」，模型能做；但如果想说「你现在该压缩了」，模型**做不到**——它只能等 `thresholdRatio` 0.8 撞墙。

这正是 `clm-to-dsh-portability.md` 第 ③ 条（压缩闸门）的上游问题：闸门是给「模型驱动压缩」配的防御，而模型驱动压缩本身在 DSH 里还不存在。**所以 PR-3 的真正内容不是「加闸门」，而是「加入口 + 加闸门」，并且入口一出现，`fit`/`shrink` 校验就是不可选项**——CLM 专门为「模型用重复内容把上下文撑大」这个错误写了 `edit_gate.rejected_note`，说明这是必然会发生的失败模式，不是假想。

这也反过来约束 PR-2 的文案：**在 PR-3 落地之前，nudge 不能建议压缩**，只能建议「收敛当前工作」。文案里写「consider compacting」而模型没有这个工具，就是在教它幻觉。

---

## 6. 需要实测才能定的三个数

诚实标出来，这些是设计里唯一没有根据的部分：

1. **`persistentNudgeObsMult = 2.0`。** CLM 的默认值是 2.0，但那是**它们**的输出尺寸分布下的。DSH 的 tool 输出分布很不一样（一次 `read` 可能 8k token，一次 `grep` 可能 200 token），2.0 可能让带宽长期贴着 50% 上限。建议实现时先用 2.0 但把带宽命中打日志，跑几个真实长会话再看。
2. **`observationWindow = 3`。** 同样是 CLM 的值（`ADAPTIVE_OBS_WINDOW = 3`）。DSH 里 3 够不够覆盖「一次 read + 一次 bash」的突发，没测过。
3. **`ADAPTIVE_FLOOR = 0.5`（带宽不超过剩余空间的 50%）。** 这个更像是个保护而不是调参；保留。

三个数都进 Config，不进常量——符合仓库「No hardcoded tunables in plugins」那条。

---

## 7. 测试与快照

| 层 | 要覆盖什么 |
|---|---|
| `pressure.spec.ts`（纯函数） | 带宽计算：小输出退化成 90% 规则；单次巨型输出被 50% 上限夹住；窗口内取值；`contextWindow` 缺失时不提醒（没有百分比就不知道该不该担心） |
| `nudge.spec.ts`（纯函数） | 状态机：进入带宽提醒一次；带宽内小幅上涨不再提醒；离开带宽后重新武装；reject 不提醒 |
| `plugin.spec.ts` | `agent/pre-step` 上 `await next()` 不短路；`reject` 原样透传且不追加消息；`enabled:false`；meter 缺失不抛；和 `compaction-basic` 同栈时看到压缩**之后**的数字 |
| `composition.spec.ts` | 真组合：token-meter + compaction-basic + PR-1 + PR-2，断言 pre-step 注入顺序与 `user/message` surfaceOp append |
| 快照 | 新增一例：走到带宽内 → 提醒一次 → 下一个大输出 → 跨越并触发压缩 → 压缩后不再提醒（re-arm 到下一轮才生效） |

**快照成本要提前认。** PR-1 挂进 base bundle 后 85 个 session 快照全红（`context: ~8.2k tokens` 进了每一条），是我的改动带来的，得一起 refresh。PR-2 的 nudge 只在带宽内触发，正常短会话碰不到，所以**预期不改动那 85 条**——但这一条必须在实测里验证，不能假设。

---

## 8. PR 切分

| PR | 内容 | 阻塞关系 |
|---|---|---|
| PR-1 | 读数（已落地） | — |
| **PR-2** | danger-band nudge（本文） | 依赖 PR-1 |
| PR-2.5 | 先实测 §6 的三个数，必要时只调默认值 | 依赖 PR-2 有日志 |
| **PR-3** | 模型可用的压缩入口 + `fit`/`shrink` 闸门 | 需要 `CompactionEngine` Service Definition 扩展 + `docs/architecture.md` |

PR-3 之所以排最后且单独一个 PR，是因为它动 Service Definition——按仓库规矩这是「capability seam 的变化」，不是「加个插件」，评审面和 PR-2 完全不同。

---

## 9. 一句话

CLM 的阶梯提醒里，25/50/75 三档是**为「越限即死亡」的 harness 设计的**，DSH 有自动压缩这个安全网，照抄只会变成噪音；真正该搬的是它中间那层——**按最近一次 observation 的尺寸动态决定「危险带」有多宽**，因为 DSH 的压缩检查只发生在 pre-step，一次大输出可以绕过它，而这个动态带宽正是为了让提醒赶在那次大输出之前落地。
