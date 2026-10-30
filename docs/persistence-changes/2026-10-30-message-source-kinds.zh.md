---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-30-message-source-kinds

[English](2026-10-30-message-source-kinds.md) | 中文

## 概述

新增两个 MessageSourceMap 变体——context-pressure-reminder 与 compaction-basic——让上下文压力守卫和模型主动压缩产生的用户消息记录各自的写入方。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-30-message-source-kinds
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "f9eb2ef0c37d9495390c4c4603bdcf713077b92150e2e971fe47625748f5c06e"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "d478a97924aabb6222670fa4293db53a81ef7aa5781fe412031c6be8668371c0"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "1fc26a47547def541212bdbeb3f0eb49283da1c0524b3b61aba7bd08854fee3c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "a028a9a289dbb31f093e37674ae931ad431e3276193555b8a6111ef09331dbfe"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

两个方向都安全。source kind 是合并可扩展的联合类型：各生产者在自己模块内声明自己的 kind，消费方对未知 kind 走默认分支（packages/llm/llm/src/message.ts）。旧读取方遇到这两个变体时照常读取消息，并把持久化的 kind 作为生产者标签显示，这正是聊天投影中已有的默认分支（packages/client/ui-chat/src/client/conversation-nodes/event-projection.ts）。持久化的事件类型仍是已知的 user/message，因此 packages/core/session/src/known-event-types.ts 的 fail-closed 词表检查不会拒绝这些日志，也不需要 ignorable 标记：消息本身必须被读取，新增的只是它的归属信息。新读取方遇到旧日志时看不到缺失的变体，因为这些 kind 只由本次改动中的包写入。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/guard/context-pressure-reminder packages/compaction/compaction-basic packages/compaction/tool-compact：293 个测试通过。keyless 录制会话快照 snapshots/session/context-pressure-reminder、context-pressure-nudge、context-compact-tool 通过 dsh --profile headless 回放全绿。

<a id="dev-note"></a>
## 开发备注

无。
