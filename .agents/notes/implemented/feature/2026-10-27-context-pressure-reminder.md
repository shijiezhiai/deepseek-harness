# Agent Note: Per-step context pressure as a fold-onto-consumer guard

Status: implemented

English | [中文](2026-10-27-context-pressure-reminder.zh.md)

## Problem

DSH tells the model nothing about how much context its next step will occupy. The token meter measures every step and the compaction engine reads the same number, but neither publishes it: a model discovers pressure only when compaction removes the middle of its history, with no advance warning and no way to change tactics first. The model that could shrink its own working set — by reading less, writing to a file instead of the transcript, or delegating — never learns that it should.

## Decision

`@deepseek-ai/dsh-context-pressure-reminder` (`packages/guard/context-pressure-reminder/`) observes each tool step and appends one reading to the next step's context: `[context: ~48.2k tokens]`, with a window-relative percentage appended when the route publishes a context window.

The injection point is the guard group's existing seam. A `tools/post-execute` listener calls `tokenMeter.measure()` once per step, applies an optional `minDeltaRatio` debounce against the last **published** reading, and returns `{ kind: 'accept', additionalContexts: [message] }`. The loop's active-batch FIFO merges that into the next step's inbox, so the reading arrives as an ordinary surface `user/message` and is logged like any other model input.

Three properties follow from that seam and are the reason it was chosen over a new tool or a new session event:

- **Fold onto the downstream decision.** The guard never competes for the tool result. It appends to whatever another `post-execute` listener decided — a downstream `block` still blocks, a downstream `accept` keeps its own `additionalContexts` after the reading — because the guard's contribution is additive context, not a verdict. No second `tools/post-execute` producer for the same call, and no new `SessionEventMap` member.
- **Model-visible ⟺ logged.** The message reaches the surface through the loop's own splice, so replay, compaction, and the SDKs see it without special handling.
- **Zero new configuration on the model side.** The reading is a plain user message; adapters carry no burden.

The guard publishes nothing when no token meter is mounted, warning once per plugin lifetime rather than failing the turn: a deployment that omits the meter has chosen not to measure, and a guard is not a dependency the turn should die for.

The reading is deliberately limited to a number. It does not suggest an action, name a threshold, or fire at a particular ratio — deciding what pressure means is the model's job, and a guard that prescribes tactics duplicates compaction's policy and ages badly against model batches. `minDeltaRatio` exists only to keep a stalled measurement from repeating itself every step; it is not a trigger.

## Alternatives considered

- **A `context-pressure` tool the model calls on demand.** Rejected: the model does not know when to ask, so the reading would arrive after the moment it mattered, and every call costs a round trip.
- **A new session event carrying the measurement.** Rejected: the reading is model-visible input, so it needs a surface message anyway; emitting an event as well would create two records of one fact and a second surface producer to keep in sync.
- **Returning `{ kind: 'block' }` to force the model to react.** Rejected: a guard that refuses tool calls hijacks the loop. Pressure is advice, not a veto.
- **Publishing at a threshold ratio instead of every step.** Rejected: a threshold is compaction's `thresholdRatio` under another name, and a model that sees the number on every step learns the shape of its own consumption instead of being ambushed at a boundary.
- **Rendering a percentage always.** Rejected: `resolveModelInfo` does not always publish a context window, and inventing a denominator would state a budget the harness does not know.
- **Exposing a per-turn query tool instead of putting the split in the reading.** Rejected: the model would have to know when to ask, and the split only matters at the moment it decides what to give up — which is exactly when it reads the number.
- **Recording turn ownership on the token meter's nodes.** Rejected: the meter prices a surface, not a conversation structure; adding turn fields would push this guard's needs into a capability every consumer shares. The guard already listens to `session/event` for its debounce and band, so the turn starts cost no extra pass.

## Consequences

- One `measure()` per tool step, and only when a tool step occurs — a turn with no tool calls publishes nothing, because a text-only turn gives the model no chance to act on the reading anyway.
- Debounced readings mean log volume tracks context growth, not step count; with the default `minDeltaRatio` a long, stable step sequence records far fewer messages. The 0.02 default came from simulating 100-step sessions over heavy-tailed tool-output sizes: 0.005 publishes 38–53 readings per session, 0.05 and above can leave the number stale for 10–13 consecutive steps, and 0.02 lands near 27–35 readings with a worst gap of 7–8 steps.
- The truncation unit and precision are configuration (`unit`, `precision`), so deployments can choose raw counts for machine parsing instead of abbreviated ones.
- The reading carries a per-turn split once two turns still hold surface content: `[context: ~48.2k/200k tokens · 24% · turns 1-3: 6.0k 12.4k 21.8k]`. A node belongs to the newest `turn/start` at or before its sequence number, so the split is derived from the measurement's own priced nodes rather than a second scan, and it stays correct after compaction splices a checkpoint into the middle of the surface array (the array stops being sequence-ordered; position-based splitting would misfile that checkpoint). Turns that compaction emptied drop out instead of printing zero, and turns beyond `maxTurnsInReading` collapse into one additive `earlier` figure.
- The split is withheld for a single-turn surface. Its sizes would restate the total, and 163 of the 167 recorded sessions that contain a reading never leave their first turn, so the short form is both the common case and the one the snapshots pin.
- Compaction and this guard both read the token meter and neither owns it. Compaction decides what to remove under pressure ([after-call cohesion Agent Note](../../archived/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md)); this guard only reports the number, so the two never specify the same policy. A future change to the meter's meaning affects both, which is the point: they agree on what "pressure" is by construction.
- The guard does not run between an assistant message and its own tool results, so a step whose tools balloon the context shows up only on the following step. Closing that gap would need a surface producer outside the tool pipeline, and was left out of this scope.
