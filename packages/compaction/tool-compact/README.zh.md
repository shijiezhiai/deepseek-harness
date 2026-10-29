---
description: "面向模型的 compact_context 工具：模型如何请求压缩、读回什么，以及后端如何作答。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-compact

[English](README.md) | 中文

## 概述

`dsh-tool-compact` 把任何自动化都不具备的那一方视角交给模型：它自己决定正在携带的对话是否已经不再匹配它需要的东西。`compact_context` 工具让模型在轮中说出这一点，压缩后端在下一步作答，附一条描述折叠了什么的通知。在此之前，每一次压缩都由占用率、提供方拒绝过长请求、或人敲 `/compact` 触发。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把它挂在会响应请求的后端旁边。随包发布的 `dsh` base 已经把它挂在 `compaction-basic` 旁边，所以通常可以直接用。

### 使用工具

| 输入 | 结果 |
|---|---|
| `compact_context()` | 调用返回 `requested`；压缩在下一个轮步骤之前跑完，模型读到折叠了什么。 |
| `compact_context({ focus })` | 同上，focus 记录在调用上。无法透传 focus 的后端仍然执行压缩。 |
| 没有值得折叠的内容 | 请求被拒绝，模型被告知原因；对话不变。 |

### 模型读到什么

工具结果本身不携带分析——它只是确认请求。回答在下一步作为普通用户消息到达，因此它是模型从日志重建出来的内容的一部分：

| 情况 | 通知 |
|---|---|
| 已压缩 | 有多少条历史被折叠进摘要，以及估计回收的 token。 |
| 被拒，表面太小 | 对话低于占用下限，此时压缩会删掉模型仍需要的状态。 |
| 被拒，额度用尽 | 本轮模型发起的压缩次数已用完。 |
| 被拒，本轮已压缩 | 本轮已经有东西在模型没要求的情况下压缩过；模型测量的表面不是它正在看的那个。 |

每条通知只写一次。被拒的请求不会在随后的每一步重复。

### 组合工具

挂上工具与响应它的后端：

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
- id: tool-compact
  name: '@deepseek-ai/dsh-tool-compact'
```

只挂工具而没有会响应的后端时，`compact_context` 仍然出现在工具列表里，但永远不会得到回答。如果工具是因为别的原因挂载的，在 `compaction-basic` 上设 `serveRequests: false` 把这件事变成明确的。

### 调整闸门

两道闸门都归 `compaction-basic`，工具本身没有配置。

| 字段 | 默认值 | 效果 |
|---|---|---|
| `requestPolicy.minContextRatio` | `0.10` | 响应请求的最低占用（窗口的比例）。 |
| `requestPolicy.maxPerTurn` | `2` | 一轮内允许的模型请求压缩次数。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节解释为何如此拆分；可观察行为见[使用本包](#use-this-package)。

### 设计理念

工具与后端是同一条缝的两半，且从不共享状态：

- **请求就是工具调用。** 没有单独的请求事件。`request.ts` 从持久日志里折叠出 `tool/call` 事件，找出后端尚未回答的 `compact_context` 调用，于是请求单凭日志即可重建。
- **工具声明 `deferContext`。** 循环据此记录：这次调用之后会跟着模型自己推不出来的上下文；这正是通知能以用户消息形式到达、而不被当成模型自述的原因。
- **Service Definition 不动。** `CompactionEngine` 不增加任何成员；后端把请求服务实现为私有方法，通过已有的 `agent/pre-step` 监听器抵达。

### 只作答一次

`agent/pre-step` 在每次请求之前运行。后端每轮最多认领一个未决请求，并在压缩之前先标记为已作答，于是压缩的那一步与拒绝的那一步都恰好产出一条通知。作答以轮为界：新的 `turn/start` 让上一轮留下的一切未决请求退休。

在碰总结器之前，若测得占用低于 `minContextRatio`、`maxPerTurn` 已用完、或本轮已经记录过一次模型没要求的压缩，请求就被拒绝。最后那道闸门既不需要时间戳也不需要阈值：同一轮里发生自动压缩，本身就是表面在模型脚下变过的证据。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：注册 `compact_context`、校验输入、呈现 |
| [`src/request.ts`](src/request.ts) | 日志折叠：找出未作答的请求，并在轮边界令其退休 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴随文件（没有本包自有的持久事件可断言；认领账本私有于单个监听器） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [压缩缝](../compaction/README.zh.md) —— 本工具所请求的压缩契约。
- [压缩基础后端](../compaction-basic/README.zh.md) —— 响应请求的随包后端。
- [上下文压力读数](../../guard/context-pressure-reminder/README.zh.md) —— 在模型决定开口之前告诉它上下文大小的读数。
- [模型发起的压缩 Agent Note](../../../.agents/notes/implemented/feature/2026-10-29-model-initiated-compaction.zh.md) —— 三道闸门，以及 Service Definition 为何保持不变。

-----

<a id="model-experience"></a>
## 模型体验

### 决定压缩

#### 模型看到什么

工具定义、它自己的 `compact_context` 调用、确认该调用的工具结果，以及下一步的通知。通知是普通用户消息，说明折叠了什么，或为什么什么都没做。

#### Token 影响

工具结果是几个 token。压缩成功后，一段较旧的历史被一条带框架的摘要替换，从而减少后续每次请求；总结本身是一次辅助请求。被拒的请求只花一条短通知。

#### KV Cache 影响

发现过程零成本。接受后的表面替换会让复用从第一个被遮蔽的历史 token 起失效，这与任何其他压缩代价相同。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **focus 只被记录，尚未送达** —— `focus` 随工具调用传递并进入呈现，但 `compactRegion` 目前无法把 focus 透传给总结器，因此摘要不受它引导。
- **响应需要后端** —— 工具本身不执行压缩；组合必须挂载会响应请求的后端。
- **一个轮边界一个请求** —— 被某轮认领、但该轮在下一步之前结束的请求会退休且不被作答。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发者说明是维护者的工作上下文，明确非权威；随包行为以上面各节、包代码与所链接的 Agent Note 为准。

- **送达 focus，未定** —— 透传 focus 需要后端持有一个总结器输入字段；工具已经记录了它。
- **闸门调参，开放** —— `0.10` 的下限与每轮 `2` 次都是未经测量的起点，取值理由是不让一次请求删掉工作集，也不让它变成循环。

</details>
