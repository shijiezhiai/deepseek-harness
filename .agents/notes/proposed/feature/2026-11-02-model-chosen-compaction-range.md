# Agent Note: Model-chosen compaction range

Status: proposed

English | [中文](2026-11-02-model-chosen-compaction-range.zh.md)

## Problem

`compact_context` tells the model that compaction exists but lets it choose nothing about it. The tool accepts only `focus`, and `serveModelRequest` hard-codes `selectCompactableRange(session, pruned, 0)`, so the backend alone decides which span is folded away and how much tail survives. The model knows it is under pressure and cannot say what to give up.

The CLM work on editing economy is worth taking here, but not its mechanism. Its mechanism — mirroring the context into a file the model rewrites — is unavailable: `packages/core/session/src/surface.ts` requires that a `surfaceOp: replace` region rewrite `tool/result` nodes only through `content` and carry `sourceEventSeqs` for every shadowed seq (`assertToolResultRewrite`), so free-form text editing drops tool-call/result pairing and makes Anthropic- and Bedrock-shaped backends reject the request outright.

What survives that constraint is narrower and still useful: **the decision of where to cut moves to the model; legality, budget, and gating stay in the harness.** The economics CLM writes into its prompt — one large compaction beats several small ones, and a small early edit costs a full re-read of everything below it — describe a choice the model cannot currently make.

`focus` was a second instance of the same gap and is fixed separately: `SummarizationInput` now carries it and `summarizeWithLlm` appends it as a second content block after the unchanged instruction. That fix establishes the shape this proposal extends — the request travels to the summarizer, and the backend keeps the decision about legality.

## Proposal

Add two mutually exclusive boundary parameters to `compact_context` and resolve them into a surface range in the backend.

### Interface change

`packages/compaction/tool-compact/src/index.ts` gains two optional integer parameters beside `focus`:

| Parameter | Meaning |
|---|---|
| `throughTurn` | Compact through the end of turn N, including that turn's complete tool pairing. |
| `keepRecentTurns` | Leave the most recent N turns intact and compact everything before them. |

Setting both is a tool-layer error; setting neither preserves today's behavior. Turns, not seqs, because the model counts turns natively and cannot see surface positions — CLM anchors on `[[CTX_TURN i]]` for the same reason.

`CompactionRequest` in `packages/compaction/tool-compact/src/request.ts` gains a `boundary` field, and `readFocus` becomes `readRequestArguments`, resolving `focus` and `boundary` in one pass. Malformed values fold to "unspecified" rather than throwing, matching the existing note that the registry already validated the arguments and this fold must not invent a second validation authority.

### Resolution

A new pure function in `packages/compaction/compaction-basic/src/region.ts`:

```ts
export function planRequestedRange(
  session: Session,
  boundary: RequestBoundary,
): { start: SessionSeq; end: SessionSeq } | RequestBoundaryRefusal
```

`serveModelRequest` branches before `selectCompactableRange`: no boundary keeps the current call, a boundary goes through `planRequestedRange`.

Resolving a turn to a surface range needs a log fold, because `user/message` carries no turn (`packages/core/session/src/types.ts:315`) while `turn/start` (`:294`), `assistant/message` (`:349`), `tool/call` (`:369`), and `tool/result` (`:383`) do. The fold reads `turn/start` for each turn's opening seq, takes that turn's last `tool/result` or `assistant/message` as its closing seq, then walks up to the nearest `toolPairingBalancedAfter` boundary. `pendingCompactionRequest` already scans the log, so the turn table rides along instead of triggering a second scan.

Three new `RequestBoundaryRefusal` members join the existing set in `gate.ts`: `turn-not-found` (the requested turn exceeds the session), `turn-too-early` (the turn holds no finished surface node), and `range-unbalanced` (the resolved edge splits a pairing). Each needs a `renderRefusal` entry with an actionable instruction and the `assertNever` fallback stays.

### Tail retention

`retainTokens` and `keepRecentTurns` express different budgets and can disagree: three recent turns may hold 500 tokens or 60,000. `retainTokens` is not even a constant when unset — `config.ts:248` derives it as `Math.floor(messageBudgetTokens * policy.retainRatio)` with `DEFAULT_RETAIN_RATIO = 0.16` (`config.ts:24`). When the model supplies a boundary, the model wins and `retainTokens` drops to zero — the same value the model-request path already passes. A backend default must not silently overrule an explicit request. `planRequestedRange`'s documentation owns that contract.

The rest of the automatic paths are untouched: `compactPressure` keeps `selectCompactableRange(..., spec.retainTokens)`, `compactIfNeeded('context-overflow')` keeps `(..., 0)`, and a request carrying no boundary keeps `(..., 0)`. New logic runs only for an explicit boundary, so `snapshots/session/context-compact-tool/` stays byte-identical.

### What needs no change

The shrink gate already covers model-chosen ranges. `region.ts:423` rejects a summarization that is not strictly smaller than the shadowed content, inside the same transaction, for any range regardless of origin. Bounding the model's inflation is the one thing CLM writes a dedicated gate for and DSH already does.

`compactRegion`'s signature is unchanged too: focus established that a request which only one policy can produce travels through the transaction options rather than the abstract method.

## Implementation order

| Step | Content | Depends on | Risk |
|---|---|---|---|
| 0 | Deliver `focus` to the summarizer | none | low — one optional input ✅ shipped |
| 1 | Add per-turn sizes to the reading | the reading | medium — model-visible text, full snapshot refresh |
| 2 | `keepRecentTurns` plus `planRequestedRange` | 1 | medium-high — new refusals, snapshots, test matrix |
| 3 | `throughTurn` | 2 | decide by what 1 shows |

Step 2 is the point where CLM's editing-economy prompt text acquires an object to constrain: only then can the model weigh "compact ten turns at once" against "five separate two-turn compactions".

The turn fold reads the session log, so it inherits the `snapshotEvents()` deprecation in `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`. Two existing call sites carry waivers. A new call site needs either the same waiver with a stated reason or a migration to `eventAt`/`ownEvents`; that choice belongs with the implementation, not this note.

## Alternatives considered

- **Free-form context editing** — rejected: `assertToolResultRewrite` forbids it, and the tool-call/result pairing loss it causes breaks provider request validation. CLM pays that cost by rebuilding history as role-plus-text only; DSH's surface layer is stronger by design.
- **Seq-based ranges in the tool parameters** — rejected: the model cannot see surface positions and has no way to learn them. Turns are the unit it already counts.
- **`throughTurn` in the first cut** — deferred: it requires the model to know each turn's size, and the reading added alongside `compact_context` reports only a total. `keepRecentTurns` counts backward from the tail, where the model's picture is accurate. Revisit once the reading carries per-turn sizes.
- **Extending `CompactionEngine.compactRegion` to accept a request** — rejected: the abstract method is the seam for callers that own their range, and a boundary only one policy produces does not belong in the Service Definition.
- **Reusing `retainTokens` for `keepRecentTurns`** — rejected: token and turn budgets are not interchangeable, and converting one into the other would hide the model's explicit intent behind a heuristic.
- **Backend overriding a resolved boundary to a "safer" one** — rejected: silent adjustment makes the model's request and the actual compaction disagree with no way for the model to notice. Refuse with an actionable reason instead.

## Acceptance criteria

- `compact_context` with `throughTurn` folds every surface node through the named turn and none after it; with `keepRecentTurns` it leaves exactly the named tail. Setting both fails at the tool layer with a message naming the conflict.
- `planRequestedRange` maps a turn to a pairing-balanced range, or returns the matching refusal; each refusal reaches the model as an actionable notice, and `assertNever` still covers the closed set.
- A boundary naming a turn beyond the session, a turn with nothing finished, or an edge that would split a pairing produces its refusal and leaves the surface unchanged.
- The shrink gate rejects an inflated summarization for a model-chosen range exactly as it does for an automatically chosen one.
- A request without a boundary produces a byte-identical `compact_context` behavior to today, so existing snapshots hold.
- Keyless recorded-session snapshots cover a boundary-named compaction, a `keepRecentTurns` compaction, and one refusal; the reading's own superset of behavior stays covered by the existing scenarios.
- `docs/tool-catalog.md`, `config-catalog`, `event-producer-consumer`, and the package READMEs regenerate in the same change; `packages/compaction/tool-compact/README.md` documents both parameters and their exclusivity.

## Risks

- **The model may choose worse than the backend.** `selectCompactableRange` sees each node's token count (`measurement.nodes[].tokens`); the model sees only a total. A request that folds a cheap early stretch while a large mid-conversation result dominates the budget is a plausible failure, and the reading's per-turn sizes are the mitigation rather than something shipped here. CLM answers this by exposing each turn's size (`[[CTX_TURN]]` headers plus per-result sizes); DSH's reading reports one total.
- **An ambiguous boundary at `keepRecentTurns: 1`.** If the most recent turn holds an open tool pairing, the boundary has no legal position. This proposal refuses (`range-unbalanced`) rather than adjusting, because an adjusted boundary means what the model asked for and what was compacted differ, and the model has no way to learn that from the result. The refusal notice must name the boundary that would work.
- **Irregular history shapes reach providers.** Compacting a middle stretch while keeping earlier turns produces an arrangement the automatic path never creates. Existing `compactRegion` already varies ranges, so this is not a new class of risk, but it needs a real-provider e2e rather than inference.
- **Two refusals the model cannot act on.** `turn-too-early` and `range-unbalanced` may both describe a turn the model believes is complete. Repeated refusals would waste a step each; the notice must name the actual boundary that would work.
- **No measurement says model-chosen boundaries beat the backend.** CLM's reported gains come from an end-to-end agent benchmark over its full mechanism, not from range choice in isolation. This proposal is a capability argument, and it should be judged by whether it produces better compactions rather than by inheriting those numbers.
- **`focus` still has no length limit.** A model can write a multi-thousand-token focus into the summarization request. `StringValueSchemaSpec` has no `maxLength`, so bounding it belongs in the execution layer, not the schema, and it is not addressed here.
