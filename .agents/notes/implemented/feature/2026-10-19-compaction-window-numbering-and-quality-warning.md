# Agent Note: compaction window numbering and quality warning

Status: implemented

English | [中文](2026-10-19-compaction-window-numbering-and-quality-warning.zh.md)

## Problem

A session that compacts repeatedly leaves a transcript of `compaction/*` events, but nothing in the protocol said *which* compaction this was. Three questions stayed unanswered:

1. **How many times has this conversation been compacted?** A consumer can count `compaction/summary` events, but counting requires replaying the whole log and trusting that every summary event represents a distinct generation — a per-session ordinal said it directly.
2. **Is the model's early-history knowledge degrading?** After the first compaction the model reads a summary of the original history; after several layers of compaction it reads summaries of summaries. The industry surfaces this loss of fidelity to the user (Codex prints a warning on repeated compact windows, "long threads may be less accurate"). DSH's client rendered every marker identically, so a second-generation summary looked as trustworthy as the first.
3. **Can a plugin anchor per-generation provenance?** The gap report's roadmap wants Generation N's shadowed originals findable later; an ordinal on the landed checkpoint is the stable anchor plugins and future retrieval can key on.

## Decision

### 1. A per-session, replayable window ordinal on the summary event

`compaction/summary` gains optional `windowNumber`: a per-session 1-based ordinal counting *successful summarizing compactions only*. Failed rounds and `compaction/prune` (which has no summary at all) do not advance the counter, because the numbering describes generations of the model's view, not attempts. The basic backend derives it from its own append-only log via `nextCompactionWindowNumber(events)`: it scans landed `compaction/summary` events for the maximum `windowNumber` and returns max + 1 — so the ordinal is a pure function of the session log, replayable and crash-consistent, with no new durable state. `CompactionResult` mirrors the field. Model-independent backends may omit it (it stays optional), and the client renders older sessions without numbering as the plain label.

### 2. The client numbers generations and warns from generation two

The `CompactionSummaryNode` fixture completes the protocol field first (`windowNumber: number | null`), and `compactSummary` reads `data.windowNumber` (accepting only safe integers ≥ 1). `CompactionItem` then:

- titles the marker `第 {n} 代压缩` / `Compaction #{n}` when a window number is present (an explicit command title still wins),
- shows a one-line quality note — *"多次压缩后，模型对早期对话的记忆可能不准"* / *"After repeated compactions, the model may be less accurate about early conversation details"* — as a `role="note"` paragraph when `windowNumber ≥ 2`, and
- keeps the marking clean: the note renders once per marker, costs zero model tokens (UI-only copy, amber label on the topic color), and carries no new information into the model stream.

### 3. Provenance anchor for the ecosystem

`windowNumber` on the checkpoint gives plugins a stable per-generation key: given the ordinal, a plugin can walk the session log and recover exactly which shadowed ranges each generation covered. Retrieval/decompression stays with the plugin ecosystem (billion-context), as decided for the shadowed-range mirror (2026-10-19); numbering is the DSH-side anchor that makes that retrieval deterministic.

## Alternatives considered

**Front-loading the ordinal as `compaction/start`'s pre-allocated generation.** Rejected: a start may never land a summary (veto, failure, retry), and numbering attempts as generations would make the model's view skip numbers. Deriving at commit time from landed summaries keeps the ordinal equal to "generation of the model view".

**Storing the counter as new durable backend state.** Rejected: the append-only log already records every landed summary; a separate counter would have to be kept transactionally consistent with the log and would break replay for new backends. Computing max+1 over the log is idempotent, crash-safe, and free.

**Wiring the warning into the model stream (e.g. a system-prompt note).** Rejected: pointing the model at its own degraded memory costs tokens every round and adds no actionable signal; the warning is a user-facing affordance, so it lives in the client only.

## Consequences

- Consumers can now answer "which compaction is this" without replaying the log: `windowNumber` on the summary event and on `CompactionResult`.
- The client distinguishes generations visually and warns from generation two onward, matching the industry's repeated-compact fidelity warning without spending model tokens.
- Plugins get a deterministic per-generation anchor for provenance and future retrieval; numbering is derived from the log, so replays and crash recovery produce identical ordinals.
- The field is optional at the contract, so non-measuring backends and older session logs remain valid.

## Testing

- `compaction-basic.spec.ts`: `derives the next window ordinal from landed summaries only` (empty log → 1, one summary → 2, two → 3, and a later failed round plus a prune still → 3) and `assigns monotonically increasing windows across repeated compactions` (two successful rounds land 1 then 2; a failed attempt does not bump the counter).
- `chat-branch-tails.client.spec.tsx`: window fixture titles with `第 N 代压缩`, and the repeated-compaction warning renders from generation two and is absent for generation one and legacy sessions.
- `conversation-node-definitions.client.spec.ts`: an automatic compaction summary carrying `windowNumber: 3` flows through `compactSummary` into the node.
- Full gates: compaction suite 206 tests, client `tsc` (tsconfig.client.json), and the full `test:gui` suite (288 files, 3,824 tests) pass.
