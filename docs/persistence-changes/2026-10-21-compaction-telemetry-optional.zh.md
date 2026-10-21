---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-21-compaction-telemetry-optional

[English](2026-10-21-compaction-telemetry-optional.md) | 中文

## 概述

为压缩摘要与关闭记录增加可选遥测：每会话压缩代次序号、替换前后计量占用、以及摘要调用耗时。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-21-compaction-telemetry-optional
baseline: false
changes:
  - root: "event:compaction/end"
    previous: "2026-09-11-initial"
    after: "ccdd69bd68a0425f3c79ccb74720b585dad18a33e3aff228feaafe897a6477bc"
    decision: same-version
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "2154efd5517acfdbbc5ce5051383c4366a9bc70dc7910819163a9a5e373267a1"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效，旧读取方继续工作：新增属性全部可选，判别字段未变。不认识该字段的读取方忽略它；认识的读取方把缺失视为未测量，绝不视为 0。省略这些字段的写入方同样可读，压缩语义、范围选择与表面替换均不依赖它们。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/compaction packages/llm/token-meter：361 个测试通过。compaction-output-reserve、compaction-recovery、compaction-summary-headroom 与 SDK 图片压缩场景的无密钥会话快照在刷新后重放通过。

<a id="dev-note"></a>
## 开发备注

无。
