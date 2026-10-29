# Agent Note: A danger band sized by the observations the session produced

Status: implemented

English | [中文](2026-10-28-context-pressure-nudge.zh.md)

## Problem

The per-step reading tells the model how large its context is, but a number is not an alarm: a model that reads `~95k/100k` on a step still has to decide, unaided, that this is the step where one more broad `grep` ends the run. Compaction then resolves the pressure by deleting the middle of the history, which is the expensive outcome the reading exists to prevent. The gap between "the model knows the number" and "the model changes tactics in time" is one step wide, and the reading alone does not close it.

## Decision

`@deepseek-ai/dsh-context-pressure-reminder` adds a second message on the `agent/pre-step` seam. When the remaining headroom is narrower than one more large observation, the guard appends a warning to the step the model is about to take:

```
[context: ~95.0k/100.0k tokens · 95% — one more large tool result can overshoot the window; prefer finishing a unit of work and writing findings to a file]
```

The band is `clamp(observationMultiplier × largest recent tool result, minBandRatio × window, maxBandRatio × window)`, sized from the tool results the session actually produced rather than from a fixed ratio. A session reading single files has a narrow band and gets warned late; a session whose calls return whole files has a wide one and gets warned early, which is the asymmetry that matters — the risk is the size of the *next* observation, not the size of the context.

Four properties of the seam are load-bearing:

- **`agent/pre-step` runs before the step, not after the tool.** The post-execute reading describes the step that already spent its tool budget; the nudge has to arrive while the model can still choose a cheaper tool. This is also why it cannot be a second post-execute message: by then the decision it wants to influence is gone.
- **Await downstream, then append.** The listener calls `await next()` and appends its message to the decision that comes back. Prepending would place the nudge before another listener's contexts and, more importantly, before compaction's own pre-step rewrite; appending keeps every listener's view of the step consistent with the order they registered in.
- **`reject` passes through untouched.** A step another listener vetoed must not gain a message from a guard, and an aborted signal publishes nothing.
- **The nudge never names compaction.** The model has no tool that compacts before the compaction entry point exists, so advice to compact would describe a capability the model does not have. It names a tactic the model owns: finish a unit of work, write findings to a file.

The band is re-armed by leaving it: the guard remembers the occupancy it warned at and stays silent while the session stays inside the band, so a long session near the ceiling reads one warning rather than one per step. `minDeltaRatio`, already the reading's debounce, governs the repeat when a session sits inside the band and keeps growing.

Every number that is not measured is configuration — `observationMultiplier`, `observationWindow`, `minBandRatio`, `maxBandRatio` — because the useful value depends on the work. The defaults (`2`, `3`, `0.1`, `0.5`) are reasonable starting points, not results: no recorded session has been calibrated against them yet.

## Alternatives considered

- **A fixed ratio ladder (25% / 50% / 75%).** Rejected: a percentage of the window says nothing about what the next call will cost. A session at 50% that only runs `ls` is in no danger, and warning it trains the model to ignore the warning.
- **Reading compaction's `thresholdRatio` and warning above it.** Rejected: that makes the guard's message a restatement of compaction's policy, and the number guarding the boundary would drift whenever compaction's default changed. The compaction engine publishes no read-only threshold anyway, so this would have widened its Service Definition to copy a decision the guard should not own.
- **A hard block on oversized tool calls.** Rejected: a guard that refuses calls hijacks the loop, and the model cannot retry with a smaller request it never got to plan.
- **Rewriting the reading instead of adding a message.** Rejected: the reading is a fact about occupancy and belongs on every step; the warning is a judgement about the next step. Merging them makes a step that is merely large read like a step that is dangerous.
- **Warn once per turn.** Rejected: a turn can be a hundred steps long, and the whole point is that the danger is re-entered after findings are written to a file.

## Consequences

- A step inside the band receives two messages when both fire: the reading from the previous tool result and the nudge for this step. They are independently scheduled and independently debounced, which is why the tests assert each appears once rather than asserting a combined count.
- The band needs a published context window. On a route that publishes none, the nudge is silent while the reading still reports a raw count; sizing a band against an unknown denominator would mean inventing one.
- Two occupancy measurements can differ by one tool result: the reading is measured at post-execute, the nudge at pre-step, and a step with no tool calls in between leaves the nudge looking at the same number. Both measurements go through the shared meter, so they never disagree about the same request, only about different ones.
- The guard now listens on two seams and keeps two baselines per agent. Both stay private to the plugin's own listeners, which is why `invariant.ts` still asserts nothing: there is no package-owned durable event whose relationship could be checked.
- The nudge is calibrated against nothing. `observationMultiplier: 2` and `observationWindow: 3` are guesses about how much variance a session's tool results have; a session whose sizes vary by an order of magnitude will see the band move by an order of magnitude too. Measuring that on real recordings is deferred work, not a finished decision.
