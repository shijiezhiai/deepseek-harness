# CLM 思想能否移植进 DeepSeek Harness

> 调研对象：`facebookresearch/context-language-models`（arXiv 2609.37725，UW + Meta Superintelligence Labs）
> 对照实现：DSH `packages/compaction*`（4 包）+ `packages/core/session` surface 层 + `packages/context/*` 注入插件
> 方法：CLM 仓库源码通读（`clm_harness` 核心 5 个文件全文）+ DSH 对应 seam 逐条核对
> 日期：2026-10-27

---

## 1. CLM 到底做了什么

一句话：**把上下文当成一个模型可以自己改的文件**，而不是一个由外部策略管理的缓冲区。

机制拆成四层：

| 层 | 实现 | 关键文件 |
|---|---|---|
| 镜像 | 每轮执行命令前，把「受保护前缀之外」的对话渲染成 `/tmp/.live_ctx/LIVE_CTX_MAIN.txt`，每轮带 `[[CTX_TURN i role=...]]` 头 | `context_env/env.py:182-258` |
| 回写 | 命令执行后把文件读回，`parse_back()` 容忍地解析回合法 message list | `context_utils/context_string.py` |
| 闸门 | 编辑结果若变大则拒绝（`fit`/`shrink` 两种策略），拒绝时给模型可执行的说明 | `context_env/edit_gate.py` |
| 预算 | 确定性 gate：25/50/75% 逐级提醒（一次性、可重新触发）、超阈值每轮持续提醒（`adaptive` 按最近 3 次输出自适应）、命中上限时回滚最新 turn 再逼一次压缩（最多 50 次） | `utils/budget.py` |

三个我认为真正是「洞察」而非实现细节的点：

1. **决策权交给模型，执行权留在 harness。** 模型说「压缩第 7 轮」，闸门负责合法性、预算、拒绝理由。模型不需要知道 tokenizer，只需要知道「现在多大、上限多少、超了」。
2. **编辑的代价是「后面全部重读」。** 所以 prompt 里明写：一次大批量压缩优于多次小编辑；别压早期小段却留着长尾。这是 KV cache 经济性被翻译成了模型能执行的指令。
3. **「用代码定位，不要重打文本」。** 上下文很长时模型复述原文既贵又容易错配，让它用正则按 `[[CTX_TURN n]]` 头切片。

论文宣称的收益（zero-shot 下 BrowseComp-Plus +11.4% 准确率、−21.5% FLOPs；EdgeBench +5%、−59% FLOPs）来自这套东西 + 便宜的 suffix cache。**注意：这些数字是端到端 agent benchmark 上的，不是 harness 层面的收益，移植时不能直接继承。**

---

## 2. DSH 现状对照

| 维度 | CLM | DSH 现状 | 结论 |
|---|---|---|---|
| 上下文表示 | 可变文本文件 | 严格校验的 append-only log + surface（`surfaceOp`、`sourceEventSeqs` 来源记录、tool-pairing 平衡） | DSH 的约束更强，是**有意**的 |
| 谁决定压缩 | 模型 | 规则（`thresholdRatio` 0.8）+ `/compact` 手动 + 溢出重试 | 差异真实存在 |
| 摘要生成 | 模型自己写，就地替换 | LLM 8-section 工程纪要，`replace` 整段 | DSH 更结构化、更省调用 |
| 预算可见性 | 每次工具结果附 `[context: ~N/M tokens]` + `OVER` 标记 | **模型完全不知道自己的预算**（`system-prompt` 不提，`token-meter` 的 `pressureTokens` 只给插件用） | **DSH 缺** |
| 渐进提醒 | 25/50/75% 分级 + 持续提醒 | 无（只在 0.8 一次性触发） | **DSH 缺** |
| 压缩闸门 | `fit`/`shrink`，拒绝并解释 | 无（`compactRegion` 只校验 tool-pairing 与区间合法性，不校验是否变小） | **DSH 缺** |
| 可逆 / 检索 | 无（改完就没了） | 内置无，但本会话跑的 billion-context 插件有 `decompress` + `search_context` | DSH 生态已有 |
| 多 agent 上下文 | 多个 agent 的上下文各自是文件 | subagent 独立 session（显式隔离设计） | 定位差异，非差距 |
| serving 加速 | suffix cache reuse（vLLM / SGLang patch） | harness 无 KV cache；但 `compaction-basic` 已做「逐字节重放前缀复用 warm prefix」 | 同构思想，已覆盖 |

**一个必须先说清的前提**：DSH 根目录那份 `deepseek-harness-context-compression-gap.md` 已经盘点过一轮，结论是「核心机制与 Codex/Claude Code 同代」。CLM 没有推翻这个结论 —— 它补的不是「摘要能力」，而是**「模型对上下文的自主权」与「预算的可见性」**。这两件事 DSH 确实是空白。

另外要诚实指出：本会话正在跑的 billion-context 插件已经是「模型自主决定压缩哪个区间 + 可逆 + 可检索」，从「谁决定」这个维度看，DSH *生态* 早就有了 CLM 的主线能力。所以真正的增量不在「模型驱动压缩」，而在下面几条具体的、可落地的小东西。

---

## 3. 能搬的（按性价比排序）

### ① 模型可见的上下文读数 —— 最值得做

CLM 每次工具返回都附 `\n[context: ~{tokens_now}/{budget} tokens — OVER; compact ...]`。DSH 里模型全程盲飞：它不知道自己离 0.8 阈值还有多远，也就无法主动收敛。

- **落点**：`agent/post-execute` 或工具结果的 `notes` 通道，注入一条 `{kind:'plugin'}` 的 user message（`repeat-tool-reminder` 已是这个模式）。
- **数据源现成**：`ctx.tokenMeter` 的 `view({ contextWindow, pressureTokens, surfaceTokens })`。
- **成本**：每轮十几 token；比省下的溢出重试便宜得多。
- **注意**：`measuredBeforeTokens` 那套遥测只进日志不进模型，这里要新开一个 model-visible 通道 —— 意味着**必须新增 session event**（DSH 的「model-visible ⟺ logged」铁律）。

### ② 分级提醒（nudge ladder）

25/50/75% 逐级提醒、越过阈值后每轮持续提醒、压缩后重新装填（`note_compaction()` 重置）。

- **落点**：`agent/pre-step` waterfall，返回 `{ kind: 'enter', messages: [...] }` 追加提醒；`time-context` 与 `skill-invocation` 已是这个写法。
- **与现有规则的关系**：0.8 阈值自动压缩作为**兜底不变**，nudge 只是把「模型可以更早主动压缩」这个选项递给它。
- **价值**：DSH 的压缩是「撞墙才刹」，CLM 的经验是「提前给方向盘」。

### ③ 压缩闸门（fit / shrink）

如果要给 DSH 加模型驱动的压缩入口（或改造 billion-context 那类工具），必须要求「结果不大于基线」，否则模型会用重复内容把上下文撑大 —— CLM 专门为这个错误写了提示文案（`edit_gate.rejected_note`）。

- `compactRegion` 目前只校验区间合法性与 tool-pairing，**不校验压缩后是否真的变小**。
- 这是一条纯防御性、零模型 token 的检查，属于 DSH 现有风格的「在做出决定的操作里执行决定」。

### ④ 编辑经济性写进 prompt

「一次大批量优于多次小编辑」「注意编辑点之后的重读成本」「摘要可以写详细，因为尾部无论如何都要重读」—— 这三条是纯文案，直接可以进压缩指令或工具描述。

- 落点：`compaction-basic/src/summarizer.ts` 的 `COMPACTION_INSTRUCTION`，或模型驱动压缩工具的描述。
- 风险：改 prompt 会动快照，需要一起更新。

### ⑤ 「用代码定位」的操作纪律

若真要让模型编辑上下文，教它用锚点/正则在 bash 里切片，而不是复述原文。这条只在「上下文以某种文本形式暴露给模型」时才有意义 —— 见下一节，我认为 DSH 不该这么做。

---

## 4. 不能搬 / 会破坏不变量的

**❌ 上下文镜像文件本身（最核心的那条）**

CLM 的 `parse_back` 明确写着：历史被重建为**纯 role+text，tool-call 结构不跨编辑保留**。这在 CLM 里是「编辑自由的代价」，在 DSH 里是**不可接受**：

- `packages/core/session/src/surface.ts` 强制 `surfaceOp: replace` 区间内 `tool/result` 只能改 `content`（`assertToolResultRewrite`），且必须 `sourceEventSeqs` 引用被 shadow 的 seq；
- 失去 tool-call/result 配对会直接让 Anthropic/Bedrock 类后端 400（CLM 的 `harness.py` 里也专门处理了 unpaired tool_use 的问题，说明它自己也踩过）；
- DSH 的「model-visible ⟺ logged」要求每一次模型看到的输入都能从日志重建，自由文本编辑做不到。

**结论：搬「模型决定压缩什么」，不搬「模型编辑上下文文件」。** DSH 的 surface 层是对的，不该为这个思想让步。

**❌ suffix cache reuse** —— 纯 serving 侧（vLLM/SGLang patch），harness 没有 KV cache 可管。同构的思想 DSH 已经用「逐字节重放前缀」实现了。

**❌ RL（`clm_rl`，slime 双通道 advantage）** —— 训练侧，与 harness 无关。

**⚠️ ICL（`clm_icl`，用 proposer 循环演化自然语言上下文管理指令）** —— 思路可用：拿 DSH 的压缩 prompt 当被优化对象、用一组真实会话当评测集做 skill 优化。但这是离线工程，不是 harness 特性。

**⚠️ 多 agent 上下文共存为文件** —— DSH subagent 独立 session 是显式隔离设计，改它属于产品决策而非移植。

---

## 5. 建议的最小落地路径

如果只做一件事：**①模型可见的上下文读数**。它零架构风险、复用现成 `token-meter`、立刻让模型从「盲飞」变成「知道油表」，而且是 ②③ 的前置条件（没有读数，nudge 和闸门都无从谈起）。

如果做一组：新建 `packages/guard/context-pressure-reminder/`，按 `repeat-tool-reminder` 的骨架（`name`/`inject`/`Config`/`apply` + `./invariant` + README + Agent Note + real-composition 测试）：

1. post-execute 注入 `[context: ~N/M tokens]`（①）
2. pre-step 分级 nudge（②）
3. 若同期引入模型驱动压缩，加 shrink 闸门（③）

配套必须一起做的（DSH 规矩，不是可选项）：
- 新增 session event 承载 model-visible 读数（「model-visible ⟺ logged」）；
- 客户端 `CompactionItem` / 工具卡片的呈现（「设计工具的 UI 呈现」）；
- keyless recorded-session 快照（非平凡的模型可见改动）；
- 与 `compaction-basic` 的 0.8 阈值协调，避免 double-compact。

**不该做**：把 CLM 的镜像文件机制引进 DSH。那不是在给 DSH 加能力，是在拆掉 surface 层的校验。

---

## 6. 一句话结论

CLM 的思想里，**「上下文当归模型自己管」这个主张值得抄，「把上下文做成一个可自由编辑的文件」这个实现不值得抄**。DSH 该拿走的是它对**模型知情权**的重视（读数、分级提醒、压缩闸门），而不是它对**模型编辑权**的极端让渡。
