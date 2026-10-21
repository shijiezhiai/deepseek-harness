# Agent Note: compaction observability, round hooks, and CJK-aware metering

Status: implemented

English | [中文](2026-10-19-compaction-observability-hooks-and-cjk-metering.zh.md)

## Problem

Compaction hides older history behind a summary, but the product could not answer three questions a compaction owner actually asks:

1. **How effective was a round?** The `compaction/summary` event logged the shadowed token count and the summarization call's usage, but nothing compared the meter-priced footprint before and after the committed replacement, and nothing measured how long the transaction took. Without those numbers the realized reduction of a compaction was invisible.
2. **Can consumers participate in a round?** The only extensibility point was `summarize()`, a backend subclass hook. A consumer that wanted to veto a compaction before any durable mutation — or observe every round as it happened (telemetry, analytics, UI) — had no seam.
3. **Is the token meter accurate for Chinese?** The meter's fixed estimator priced four characters per token, a reasonable approximation for Latin text but a systematic 3–4× underestimate for CJK ideographs and JSON schema blocks containing Chinese — the exact content a DeepSeek-first harness sees constantly. Under-pricing delayed automatic pressure and made overflow recovery slow.

## Decision

### 1. Telemetry on the committed transaction

`compaction/summary` gains `measuredBeforeTokens` and `durationMs`; `compaction/end` and `CompactionResult` gain `measuredAfterTokens`. The basic backend calls the singleton `ctx.tokenMeter.measure(session)` immediately after the durable `compaction/start` (before cost, while the lock is held) and again after the replacement commits (after cost), and stamps the wall-clock transaction duration on the successful close. `measuredAfterTokens` deliberately lives on `compaction/end`, not on `compaction/summary`: the summary event is appended *before* the replacement, so it cannot honestly state a post-replacement footprint. The after value is present only for a transaction that closed without a recorded failure, and only when both measurements were taken at the exact committed generation. Consumers pair the summary's `measuredBeforeTokens` with the end's `measuredAfterTokens` to report the realized reduction. The events remain log-only — telemetry never joins the surface.

### 2. Round hooks as a second, consumer-facing extensibility point

`CompactionEngine` gains `onRound(hook)` returning a disposer, plus two protected runners. `CompactionRoundHook.before(round)` returns `'continue' | 'stop'` and may be async; a `before` returning `stop` aborts the round before any durable marker or mutation, and later hooks are not consulted. `after?(round, result)` observes every committed round with its result (or `null` when the round was skipped); observer errors are swallowed because the round already committed durably. `CompactionRoundContext` carries the `compactionId`, `kind: 'automatic' | 'manual'`, the trigger when automatic, and the measured before/after footprint when the backend measured it. The basic backend wires the runners into every round it drives: the pressure loop (each attempt), the context-overflow forced reduction, and `compactNow`'s standalone manual round. The existing `summarize()` stays the backend's summarization seam; `onRound` is the contract's consumer seam — a round is observable and vetoable without subclassing the backend.

### 3. CJK-aware token estimation

`packages/llm/token-meter/src/estimate.ts` splits estimation by character class. `estimateTextTokens(text)` walks the string, counting CJK ideographs and full-width punctuation (Han script plus `\u3000–\u303F`/`\uFF01–\uFF60`) at 1 token per character and Latin runs at the previous 4-characters-per-token rate with `Math.ceil`. Every estimator that previously priced text linearly — `estimateContent`, tool-call arguments, `estimateStructuralBlock`, tools, system — now uses `estimateTextTokens`. Pure-Latin input produces byte-identical results to the old estimator, so all 109 pre-existing meter tests stayed green, while Chinese content is priced 3–4× closer to real tokenization. CJK_CHARS_PER_TOKEN is a named constant (1), and the estimator still reduces to the recorded fixed heuristic documented in the meter README.

## Alternatives considered

**Storing the after-footprint on `compaction/summary`.** Rejected: the summary event is appended before the surface replacement, so an after-cost field would be a lie. Telemetry belongs on the transaction's close (`compaction/end`), which is appended after the replacement lands.

**Making telemetry a separate model-free backend or a `compaction/telemetry` event.** Rejected: the basic backend already owns the measurement site (it holds the lock across both measurements), and a new event would force consumers to correlate three events instead of two. Reusing the existing `compaction/summary`/`compaction/end` pair with optional numeric fields keeps the protocol one event per phase.

**Exposing `runBeforeRound`/`runAfterRound` as public contract methods.** Rejected: the runners enforce the dedicated hook lifecycle (stop short-circuits, after-errors swallowed). Public surface stays minimal; only `onRound(hook)` and its disposed registration are exported.

**Replacing the fixed estimator with a real tokenizer.** Rejected for this change: a tokenizer is a separate, larger investment. The character-class estimator is a correctness fix for the dominant error (CJK density) with zero behavior change for Latin, and it stays a documented fixed heuristic rather than a moving claim.

## Consequences

- A compaction's realized reduction is now durable, pair-able telemetry: `measuredBeforeTokens` (summary) minus `measuredAfterTokens` (end), with wall-clock `durationMs`. Post-hoc and live consumers can chart efficacy and cost per round without replaying the session or subtracting per-node prices.
- Round hooks give plugins a veto before any mutation and a reliable observation point after every committed round, for automatic and manual paths alike. The design mirrors the BeforeCompaction/AfterCompaction seam the industry has (Codex's pre/post compact hooks), without coupling the contract to any provider.
- Chinese-heavy surfaces are priced near real token counts, so pressure triggers on time and overflow recovery selects tighter reductions. Latin-only workloads are unchanged.
- The telemetry fields are optional and present only at a clean generation, so model-independent backends that do not measure remain valid `CompactionEngine` implementations.

## Testing

- `compaction-basic.spec.ts`: `telemetries the committed before/after footprint and transaction duration` asserts before > 0 on the summary, any duration, absent after on the summary, after > 0 on the end, result `measuredAfterTokens` equal to the end event's, and before > after. Six new hook tests cover before/after consultation per automatic round, stop-with-no-bracket, manual kind, disposer isolation, swallowed after-errors, and propagated before-errors (via an `ExposedCompactionHooksEngine` test subclass in the spec).
- `token-meter.spec.ts`: `estimateMessage(textMessage('中文'))` equals `2 + 4 + 4` (two CJK chars, block overhead, role overhead).
- Remaining compaction suite (204 tests) and client typecheck pass unchanged.
