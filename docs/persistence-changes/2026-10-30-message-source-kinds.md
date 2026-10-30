---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-30-message-source-kinds

English | [中文](2026-10-30-message-source-kinds.zh.md)

## Summary

Adds two MessageSourceMap variants — context-pressure-reminder and compaction-basic — so user messages produced by the context-pressure guard and by model-initiated compaction record who wrote them.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Both directions are safe. Source kind is a merge-extensible union: producers declare their own kind in their own module and consumers fall through unknown kinds (packages/llm/llm/src/message.ts). An older reader meeting either variant reads the message normally and shows its durable kind as the producer label, which is the documented default branch in the chat projection (packages/client/ui-chat/src/client/conversation-nodes/event-projection.ts). The persisted event type stays the known user/message, so the fail-closed vocabulary check in packages/core/session/src/known-event-types.ts does not refuse these logs, and no ignorable marker is needed: the message itself must be read, only its attribution is new. A newer reader facing an older log sees no missing variant, since these kinds are only written by the packages in this change.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/guard/context-pressure-reminder packages/compaction/compaction-basic packages/compaction/tool-compact: 293 tests passed. Keyless recorded-session snapshots snapshots/session/context-pressure-reminder, context-pressure-nudge, and context-compact-tool replay green through dsh --profile headless.

<a id="dev-note"></a>
## Dev Note

None.
