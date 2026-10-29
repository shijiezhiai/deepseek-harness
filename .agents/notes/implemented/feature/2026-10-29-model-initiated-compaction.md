# Agent Note: model-initiated compaction

Status: implemented

English | [中文](2026-10-29-model-initiated-compaction.zh.md)

## Problem

Every compaction in the harness was initiated by something other than the model. `compaction-basic` compacts at a step boundary when occupancy crosses `thresholdRatio`, or after a provider rejects a request as too long. A person can run `/compact`. The model itself had no way to say "the part of this conversation I am carrying is no longer what I need", even though it is the only party that knows that: it is the one that has read the tool output whose usefulness has expired, and it can see when a long exploration has produced a conclusion that lets the trail go.

`compact_context` therefore did not exist as a tool, and a model that wanted one would have had to spend a turn asking a human.

## Decision

### 1. The request is the tool call, and the answer is a later notice

`packages/compaction/tool-compact` registers `compact_context({ focus? })`. The tool returns `{ kind: 'requested' }` and does nothing else; it declares `deferContext` so the loop knows the call will be followed by context the model did not derive itself.

The backend half lives in `compaction-basic`'s `agent/pre-step` listener. Before the step's request is assembled it folds the session log (`request.ts`) to find a `compact_context` call this backend has not yet answered, and — if the gates pass — compacts and then appends one notice describing the result. The notice reaches the model on the following step as an ordinary user message, which is what `deferContext` de-duplicates against.

Declining is the same shape: the gates that refuse a request also append a notice saying why, so the model learns the outcome either way and does not re-issue a request the backend will keep refusing.

### 2. Three gates, all costing nothing to check

`serveModelRequest` refuses before touching the summarizer:

- **occupancy** (`minContextRatio`, default `0.10`): compacting a nearly empty surface discards working state the model still needs, and the token meter says the surface is nearly empty. Refused when the measured occupancy is below the floor.
- **per-turn limit** (`maxPerTurn`, default `2`): a model that has already compacted twice in one turn is not making progress by compacting a third time.
- **already-compacted-this-turn** (unconditional): if this turn already recorded a compaction the model did not ask for, the surface it is looking at is not the surface it measured. Answering would replace a region the model has not read yet, and the occupancy figure in the log describes the pre-compaction surface.

The third gate is why the figures stay honest without the backend reading `thresholdRatio` or comparing timestamps: the fact that automatic compaction ran this turn is itself the signal.

### 3. Nothing is added to the Service Definition

`CompactionEngine` still exposes only `compactIfNeeded`, `compactNow`, `compactRegion`, and `onRound`. The backend implements request serving as a private method on `BasicCompactionEngine`, reached through the same `agent/pre-step` listener that already handles pressure. A composition that mounts `tool-compact` without a backend that serves it keeps the tool visible but never gets an answer — which is why `serveRequests` exists to turn the behaviour off explicitly rather than silently.

`compactRegion` is reused unchanged; a request cannot currently pass a `focus` through to the summarizer, so `focus` is recorded on the tool call and honored in a later change rather than silently dropped.

## Alternatives considered

**Compacting synchronously inside the tool.** Rejected: the tool would have to await a summarization request while the loop is mid-step, and the model would read the result as tool output rather than as the new surface. Deferring to the next step's assembly is where every other compaction input already lands.

**A new session event for "requested".** Rejected: the `tool/call` event is the request, and `request.ts` folds it back out of the log. A second event would duplicate a fact the log already carries.

**Reading `thresholdRatio` to decide the gate.** Rejected: the threshold is the automatic path's policy, not the model's. The model asks when it wants to, and the backend answers based on what it can measure; conflating the two would make one deployment knob govern two unrelated decisions.

**Serving every request.** Rejected: `maxPerTurn` and the already-compacted gate both exist because an uncapped model loop can compact repeatedly and destroy the context it is trying to manage. The measured failure was a model that issued the same call on every single step once the surface crossed a boundary.

## Consequences

- A model can now reclaim context mid-turn without a human, and reads a notice either way.
- `compaction-basic` gains `serveRequests` and `requestPolicy`; both are validated config, changeable from `cordis.yml`.
- The `compact_context` tool appears in every composition mounting `tool-compact`, so tool-schema snapshots change once.
- `focus` is accepted and recorded but not yet delivered to the summarizer.

## Testing

- `packages/compaction/compaction-basic/tests/gate.spec.ts`: the floor is inclusive, one token below it refuses, `maxPerTurn: 0` refuses the first request, and an unknown window serves without an occupancy figure.
- `packages/compaction/tool-compact/tests/request.spec.ts`: the log fold claims one request per turn, retires it when the turn ends, ignores other tools, tolerates malformed arguments, and does not re-open an answered request.
- `packages/compaction/tool-compact/tests/tool.spec.ts`: presentation carries the focus label when present and omits `rawInput` otherwise.
- `packages/compaction/compaction-basic/tests/request.spec.ts`: real-loop cases for compaction, one-shot refusal, the already-compacted gate reached by a pressure compaction, and `serveRequests: false`.
