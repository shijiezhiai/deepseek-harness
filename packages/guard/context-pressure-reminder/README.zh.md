---
description: "循环卫生 guard：在每个工具步把当前会话的上下文规模报给模型，供决定「是否该让模型看到自己的 token 压力」的用户与维护者参考。"
kind: "package-reference"
---

# @deepseek-ai/dsh-context-pressure-reminder

[English](README.md) | 中文

## 概述

harness 每一步都会测量它即将发出的请求，而在此之前只有 compaction 消费这个数字：模型是在 compaction 删掉历史中段时才得知上下文已经满了。`dsh-context-pressure-reminder` 让模型在那之前就拿到数字。每个工具步之后，它往下一步的上下文里追加一行——`[context: ~48.2k tokens]`，当路由的模型公布了上下文窗口时再附上占窗口的比例——于是模型还能趁有余量时少读一点、把结论写进文件而不是留在对话里、或者委托出去。这条读数是建议：它不携带指令、不指明阈值，也从不阻断工具调用。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用这个包

当模型工作得足够久、上下文压力是真实风险，并且你希望它看到数字而不是被 compaction 打个措手不及时，挂载这个插件。没有工具调用的轮次它什么都不做，所以短的一次性会话不会收到额外消息。

### 何时选用

会话会跑很多工具步、工作集持续增长时选用——探索、多文件重构、长研究循环。若模型无法对数字采取行动（单问单答、固定流水线），或者每步一行也是你不想要的日志量，就跳过它。

### 设置去抖与渲染

默认在测量值有变动时发布读数；你可以调整多大的变动才值得一条消息，以及数字怎么写：

```yaml
- name: '@deepseek-ai/dsh-context-pressure-reminder'
  config:
    minDeltaRatio: 0.02   # publish when the reading moved ≥2% since the LAST PUBLISHED one
    unit: k               # k → ~48.2k ; raw → ~48200
    precision: 1          # digits after the point for the k unit
    enabled: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `minDeltaRatio` | `0.02` | 值得新发一条消息的变动比例；`0` 表示每步都发布 |
| `unit` | `k` | `k` 渲染为 `~48.2k`，`raw` 渲染为 `~48200` |
| `precision` | `1` | `k` 形式的小数位 |
| `enabled` | `true` | 总开关 |

### 设置危险带宽

读数是每一步的事实，提醒则是接近上限时的警告。带宽是「再一个大观测就会吃掉的余量」，由会话实际产生的近期工具结果来定尺度：

```yaml
- name: '@deepseek-ai/dsh-context-pressure-reminder'
  config:
    nudge:
      minBandRatio: 0.1        # floor: never a narrower band than 10% of the window
      maxBandRatio: 0.5        # ceiling: never a wider band than half the window
      observationMultiplier: 2 # one more result like the biggest one, times this
      observationWindow: 3     # recent tool results the band is sized from
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `nudge.enabled` | `true` | 是否安装接近窗口的警告 |
| `nudge.minBandRatio` | `0.1` | 带宽下界，占上下文窗口的比例 |
| `nudge.maxBandRatio` | `0.5` | 带宽上界，占上下文窗口的比例 |
| `nudge.observationMultiplier` | `2` | 对最大保留工具结果的乘数 |
| `nudge.observationWindow` | `3` | 有多少条近期工具结果参与定尺度 |

非法配置会在加载时失败——负的 `minDeltaRatio`、负数或非整数的 `precision`、未知的 `unit`、不在 `(0, 1]` 内的带宽比例、高于 `maxBandRatio` 的 `minBandRatio`、负的 `observationMultiplier`、非整数的 `observationWindow` 都会直接抛错，而不是悄悄改变行为。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-context-pressure-reminder)记录了每个可接受值。

### 你会得到什么

在默认配置下，每个让测量值变动至少 2% 的工具步之后，模型的上下文会多出一行：

```
[context: ~48.2k tokens]
```

当路由的模型公布了上下文窗口时，这一行还会带上它所占的比例：

```
[context: ~48.2k/200k tokens · 24%]
```

该消息以普通的 user 角色消息形式、归属于插件，在该步的工具结果之后到达。

当剩余余量窄于「再来一个大工具结果」时，guard 会在即将开始的那一步追加一条警告：

```
[context: ~95.0k/100.0k tokens · 95% — one more large tool result can overshoot the window; prefer finishing a unit of work and writing findings to a file]
```

会话离开带宽之前它保持沉默，因此长期贴着上限跑的会话只会读到一次警告，而不是每步一次；变动达到 `minDeltaRatio` 会重新武装它。路由不公布窗口时，警告不带百分比。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 设计原则

- **只报告，不规定。** guard 发布一次测量。战术（压缩、裁剪、委托、停止读取）属于模型与 compaction 自己的策略；一个把它们写死的 guard，不过是换了个名字的 `thresholdRatio`。
- **折叠进下游决定。** 监听器先调用 `next()`，再追加到返回值上，所以下游监听器的 `block` 依然阻断，下游的 `accept` 会保留它自己的 contexts，而读数排在它们之前。
- **通过共享 meter 测量。** `ctx.tokenMeter.measure()` 就是 compaction 用的那次调用，因此两者对「压力」的理解天然一致。
- **加载时失败得响。** `precision`、`minDeltaRatio`、`unit` 以及每个带宽字段都在 `apply` 中校验。

### 挂载位置

`tools/post-execute` 在每个工具结果落盘之后、下一步被认领之前运行。监听器每步测量一次，针对该 agent 上一次已发布的读数做去抖，然后返回 `{ kind: 'accept', additionalContexts: [message] }`。loop 的 active-batch FIFO 把这个 context 并入下一步的 inbox，后者再把它 splice 到 surface 上，成为带 source `{ kind: 'plugin', plugin: 'context-pressure-reminder', form: 'notice', summary: 'context pressure' }` 的 `user/message`。

`agent/pre-step` 承载提醒。监听器先 await 下游决策，再把消息追加到返回结果之后，因此被拒绝的步仍然被拒绝、后续监听器的 context 也保持原有顺序；loop 会在该步的第一个请求之前把每条返回消息记成 `user/message`。两个钩子都通过共享 meter 测量，所以同一步里同时发布读数和提醒时用的是同一个占用数字。

这条路径正是本 guard 不需要新增 session event、也不需要第二个 surface 生产者的原因：每条消息都是模型可见输入，因此必须被记录且可重建，而 loop 自己的 splice 已经同时保证了这两点。

同一步内的并行调用共享一条读数——去抖按 agent 计，测量描述的是这一步而不是某一次调用。提醒有自己的节奏：会话处于带宽内时每步最多一次，与它同处一步的读数是一条独立消息。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、加载时校验、post-execute 与 pre-step 监听器 |
| [`src/pressure.ts`](src/pressure.ts) | 纯渲染与去抖判定 |
| [`src/nudge.ts`](src/nudge.ts) | 纯带宽计算、提醒判定及其渲染 |
| [`src/internal.ts`](src/internal.ts) | 共享内部类型 |
| [`src/invariant.ts`](src/invariant.ts) | invariant 伴生文件（无运行时 invariant：两个基线都是单个监听器的私有状态） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Token meter](../../llm/token-meter/README.zh.md) —— 本 guard 发布的那个测量值。
- [Compaction basic](../../compaction/compaction-basic/README.zh.md) —— 同一个数字的另一个消费者，以及本 guard 刻意不复述的那套策略。
- [Tools 子系统参考](../../../docs/subsystems/tools.zh.md) —— `tools/post-execute` waterfall 与 `additionalContexts`。
- [guard 分组地图](../README.zh.md) —— 兄弟 guard 包。

-----

<a id="model-experience"></a>
## 模型体验

### 上下文压力读数

#### 模型看到什么

工具步让测量值变动后，多出一条 user 角色消息。第一行是路由未公布窗口时的纯计数读数；第二行在路由公布窗口后加上占比：

##### 读数

```markdown
[context: ~48.2k tokens]
[context: ~48.2k/200k tokens · 24%]
```

#### Token 影响

每条已发布读数约十个 token，每个跨过 `minDeltaRatio` 的步一次。不新增工具 schema，正常调用文本也不变。

#### KV Cache 影响

追加式；读数跟在可复用的请求前缀之后，不会让已有条目失效。每条读数确实会为后续步骤延长前缀，而这正是「告诉模型新信息」的预期代价。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **结论性工具之后不读** —— 带 `concludesTurn` 的结果会在该步结束本轮，任何残留的 next-step 工作都会重开这个边界、再跑一次模型请求。在那里发布等于多花一次请求去说一件本轮已不需要的事，所以读数让位于结论。同一批中更早的兄弟调用已提交的读数会保留。
- **不在 assistant 调用与其自身结果之间读** —— 某一步的工具把上下文撑爆，要到下一步才报告。补上这一缺口需要在工具流水线之外再加一个 surface 生产者。
- **不做 subagent 汇总** —— 每个 agent 的读数只覆盖它自己的 surface；父 agent 看不到子 agent 的消耗。
- **缺 token meter 不致命** —— guard 警告一次并不发布任何内容，而不是让本轮失败。
- **百分比依赖路由元数据** —— 路由不公布窗口的模型只能拿到计数。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>给维护者的工作上下文 — 点击展开</summary>

[上下文压力 Agent Note](../../../.agents/notes/implemented/feature/2026-10-27-context-pressure-reminder.zh.md)记录了这项决定与被否决的替代方案：模型主动调用的工具、专用 session event、阻断式决定、按阈值触发发布，以及总是渲染百分比。

</details>
