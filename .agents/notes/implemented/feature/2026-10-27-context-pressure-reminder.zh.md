# Agent Note：把每步上下文压力做成「折叠进下游决定」的 guard

Status: implemented

[English](2026-10-27-context-pressure-reminder.md) | 中文

## 问题

DSH 从不告诉模型它下一步会占用多少上下文。token meter 每一步都在测量，compaction 引擎读的也是同一个数字，但两者都不对外发布：模型只有在 compaction 把历史中间部分删掉时才察觉到压力，既没有预警，也没有机会先改变策略。本来可以缩小自己工作集的模型——少读一点、把内容写到文件而不是留在对话里、或者委托出去——永远不知道它现在就该这么做。

## 决定

`@deepseek-ai/dsh-context-pressure-reminder`（`packages/guard/context-pressure-reminder/`）观察每一个工具步，并把一条读数追加到下一步的上下文里：`[context: ~48.2k tokens]`；当路由公布了上下文窗口时，再补一个相对于窗口的百分比。

注入点是 guard 分组已有的接缝。一个 `tools/post-execute` 监听器对每步调用一次 `tokenMeter.measure()`，按 `minDeltaRatio` 对**上一次已发布**的读数做去抖，然后返回 `{ kind: 'accept', additionalContexts: [message] }`。loop 的 active-batch FIFO 把它并入下一步的 inbox，于是这条读数以普通的 surface `user/message` 形式到达，并像其他任何模型输入一样被记录。

这个接缝带来三个性质，也正是它胜过新工具或新 session event 的原因：

- **折叠进下游决定。** guard 从不与工具结果竞争。它追加到另一个 `post-execute` 监听器已经做出的决定上——下游的 `block` 依然阻断，下游的 `accept` 会保留它自己的 `additionalContexts` 并排在读数之后——因为 guard 的贡献是附加上下文，不是裁决。同一次调用不会出现第二个 `tools/post-execute` 生产者，也不需要新增 `SessionEventMap` 成员。
- **模型可见 ⟺ 已记录。** 消息经由 loop 自己的 splice 到达 surface，因此回放、compaction 和两个 SDK 都无需特殊处理就能看到它。
- **模型侧零新增配置。** 读数就是一条普通 user 消息，适配器不承担任何负担。

没有挂载 token meter 时 guard 什么都不发布，且只在整个插件生命周期内警告一次，而不是让本轮失败：省略 meter 的部署已经选择了不测量，而 guard 不该是让本轮死掉的那种依赖。

读数刻意只有一个数字。它不建议动作、不指明阈值、也不在某个比例上触发——判断压力意味着什么是模型的工作，而规定战术的 guard 会跟 compaction 的策略重复，并且会很快跟模型批次脱节。`minDeltaRatio` 只是为了防止停滞的测量每一步都重复自己，它不是触发器。

## 考虑过的替代方案

- **一个让模型按需调用的 `context-pressure` 工具。** 否决：模型并不知道何时该问，所以读数会在它真正需要之后才到达，而且每次调用都要多一个来回。
- **用一个新 session event 承载测量值。** 否决：读数本身就是模型可见输入，所以无论如何都需要一条 surface 消息；再发一个事件会让同一事实有两份记录，还要维护第二个 surface 生产者。
- **返回 `{ kind: 'block' }` 强迫模型反应。** 否决：拒绝工具调用的 guard 会劫持 loop。压力是建议，不是否决权。
- **在某个阈值比例上才发布，而不是每步发布。** 否决：阈值不过是换了个名字的 compaction `thresholdRatio`；每步都看到数字的模型会学到自己消耗的形状，而不是在边界上被打个措手不及。
- **总是渲染百分比。** 否决：`resolveModelInfo` 并不总是公布上下文窗口，凭空造一个分母等于陈述一个 harness 并不掌握的分词预算。

## 后果

- 每个工具步一次 `measure()`，且仅在发生工具步时——没有工具调用的轮次什么都不发布，因为纯文本轮次本来也没给模型留下采取行动的机会。
- 去抖意味着日志量跟随上下文增长而不是步数；在默认 `minDeltaRatio` 下，一段很长但稳定的步骤序列记录的消息会少得多。
- 截断单位和精度是配置项（`unit`、`precision`），部署可以选原始计数以便机器解析，而不是缩写形式。
- compaction 与本 guard 都读 token meter，也都不拥有它。compaction 决定压力下删除什么（[调用后合并 Agent Note](../architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.zh.md)）；本 guard 只报告数字，因此两者从不规定同一份策略。meter 含义的未来变更会同时影响两者，而这正是重点：它们在构造上就「压力是什么」达成一致。
- guard 不在 assistant 消息与其自身工具结果之间运行，因此某步的工具把上下文撑爆的情况只在下一步才显现。要补上这个缺口需要在工具流水线之外再加一个 surface 生产者，本次范围未包含。
