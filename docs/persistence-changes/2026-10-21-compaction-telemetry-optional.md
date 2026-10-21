---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-21-compaction-telemetry-optional

English | [中文](2026-10-21-compaction-telemetry-optional.zh.md)

## Summary

Adds optional telemetry to the compaction summary and close records: the per-session window ordinal, the metered footprint before and after the replacement, and the summarization duration.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid and readers that predate these fields keep working, because every added property is optional and no discriminator changed. A reader that does not know a field ignores it; a reader that knows it treats absence as not measured, never as zero. Writers that omit the fields stay readable, and compaction semantics, range selection, and surface replacement do not depend on them.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/compaction packages/llm/token-meter: 361 tests passed. Keyless session snapshots for compaction-output-reserve, compaction-recovery, compaction-summary-headroom, and the SDK image-compaction scenario replayed after refresh.

<a id="dev-note"></a>
## Dev Note

None.
