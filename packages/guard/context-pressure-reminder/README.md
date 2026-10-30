---
description: "Loop-hygiene guard that reports the session's context size to the model on every tool step and warns once it is one large result from the window, for users and maintainers deciding whether the model should see its own token pressure."
kind: "package-reference"
---

# @deepseek-ai/dsh-context-pressure-reminder

English | [中文](README.zh.md)

## Summary

The harness measures every request it sends, but until now only compaction consumed that number: the model learned its context was full when compaction deleted the middle of its history. This package hands the number over first. After each tool step it appends `[context: ~48.2k tokens]`, with a window-relative percentage when the routed model publishes one, so the model can read less or write findings to a file while there is still room. Once the headroom is narrower than one more large tool result, it warns before that step. Both messages are advice and never block a call.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when the model works long enough that context pressure is a real risk and you want it to see the number rather than be surprised by compaction. It does nothing on turns without tool calls, so short single-shot sessions get no extra messages.

### When to choose it

Choose it when a session runs for many tool steps and its working set grows — exploration, multi-file refactors, long research loops. Skip it when the model has no way to act on the number (a one-question session, a fixed pipeline), or when even one line per step is log volume you do not want.

### Setting the debounce and rendering

The defaults publish a reading whenever the measurement has moved; tune how much movement is worth a message, and how the number is written:

```yaml
- name: '@deepseek-ai/dsh-context-pressure-reminder'
  config:
    minDeltaRatio: 0.02   # publish when the reading moved ≥2% since the LAST PUBLISHED one
    unit: k               # k → ~48.2k ; raw → ~48200
    precision: 1          # digits after the point for the k unit
    enabled: true
```

| Field | Default | Meaning |
|---|---|---|
| `minDeltaRatio` | `0.02` | Fraction of change that earns a new message; `0` publishes every step |
| `unit` | `k` | `k` renders `~48.2k`, `raw` renders `~48200` |
| `precision` | `1` | Decimal places in the `k` form |
| `enabled` | `true` | Master switch |

### Setting the danger band

The reading is a fact on every step; the nudge is a warning near the end. The band is the headroom one more large observation would consume, sized from the recent tool results the session actually produced:

```yaml
- name: '@deepseek-ai/dsh-context-pressure-reminder'
  config:
    nudge:
      minBandRatio: 0.1        # floor: never a narrower band than 10% of the window
      maxBandRatio: 0.5        # ceiling: never a wider band than half the window
      observationMultiplier: 2 # one more result like the biggest one, times this
      observationWindow: 3     # recent tool results the band is sized from
```

| Field | Default | Meaning |
|---|---|---|
| `nudge.enabled` | `true` | Whether the near-window warning is installed at all |
| `nudge.minBandRatio` | `0.1` | Lower bound on the band, as a fraction of the context window |
| `nudge.maxBandRatio` | `0.5` | Upper bound on the band, as a fraction of the context window |
| `nudge.observationMultiplier` | `2` | Multiplier on the largest retained tool result |
| `nudge.observationWindow` | `3` | How many recent tool results size the band |

Invalid configuration fails at load — a negative `minDeltaRatio`, a negative or non-integer `precision`, an unknown `unit`, a band ratio outside `(0, 1]`, a `minBandRatio` above `maxBandRatio`, a negative `observationMultiplier`, or a non-integer `observationWindow` throws instead of silently changing behavior. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-context-pressure-reminder) documents every accepted value.

### What you get

With the defaults, the model's context gains one line after each tool step that moved the measurement by at least 2%:

```
[context: ~48.2k tokens]
```

When the routed model publishes a context window, the line also carries the share of it:

```
[context: ~48.2k/200k tokens · 24%]
```

The message arrives as an ordinary user-role message attributed to the plugin, after that step's tool results.

Once the remaining headroom is narrower than one more large tool result, the guard adds a warning to the step it is about to take:

```
[context: ~95.0k/100.0k tokens · 95% — one more large tool result can overshoot the window; prefer finishing a unit of work and writing findings to a file]
```

It stays silent until the session leaves the band again, so a session that lives near the ceiling reads the warning once rather than every step; a move of at least `minDeltaRatio` re-arms it. The warning carries no percentage for a route that publishes no window.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Report, never prescribe.** The guard publishes a measurement. Tactics (compact, prune, delegate, stop reading) belong to the model and to compaction's own policy; a guard that named them would duplicate `thresholdRatio` under a different name.
- **Fold onto the downstream decision.** The listener calls `next()` first and appends to whatever came back, so a later listener's `block` still blocks and a later `accept` keeps its own contexts, with the reading placed before them.
- **Measure through the shared meter.** `ctx.tokenMeter.measure()` is the same call compaction makes, so both agree on what pressure means.
- **Fail loud at load.** `precision`, `minDeltaRatio`, `unit`, and every band field validate in `apply`.

### Where it hooks

`tools/post-execute` runs after each tool result is durable and before the next step is claimed. The listener measures once per step, applies the debounce against that agent's last published reading, and returns `{ kind: 'accept', additionalContexts: [message] }`. The loop's active-batch FIFO merges the context into the next step's inbox, which splices it onto the surface as a `user/message` with source `{ kind: 'plugin', plugin: 'context-pressure-reminder', form: 'notice', summary: 'context pressure' }`.

`agent/pre-step` carries the nudge. The listener awaits the downstream decision and appends its message to whatever came back, so a rejected step stays rejected and a later listener's contexts keep their order; the loop logs every returned message as a `user/message` before the step's first request. Both hooks measure through the shared meter, so a step that publishes a reading and a nudge shares one occupancy number.

That is why the guard adds no session event and no second surface producer: every message is model-visible input, so it must be logged and reconstructable, and the loop's own splice already guarantees both.

Parallel calls in one step share one reading — the debounce is keyed per agent and the measurement describes the step, not the call. The nudge has its own schedule: it fires once per step while the session is inside the band, and the reading it shares a step with is a separate message.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, the post-execute and pre-step listeners |
| [`src/pressure.ts`](src/pressure.ts) | Pure rendering and debounce decisions |
| [`src/nudge.ts`](src/nudge.ts) | Pure band sizing, the nudge decision, and its rendering |
| [`src/internal.ts`](src/internal.ts) | Shared internal types |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Token meter](../../llm/token-meter/README.md) — the measurement this guard publishes.
- [Compaction basic](../../compaction/compaction-basic/README.md) — the other consumer of the same number, and the policy this guard deliberately does not restate.
- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools/post-execute` waterfall and `additionalContexts`.
- [guard group map](../README.md) — the sibling guard packages.

-----

<a id="model-experience"></a>
## Model Experience

### Context pressure reading

#### What the model sees

One extra user-role message after a tool step that moved the measurement. The first line is the count-only reading a route without a published window gets; the second adds the share once the route publishes one:

##### The reading

```markdown
[context: ~48.2k tokens]
[context: ~48.2k/200k tokens · 24%]
```

#### Token effect

Roughly ten tokens per published reading, once per step that crossed `minDeltaRatio`. No tool schema is added and no normal-call text changes.

#### KV Cache effect

Append-only; the reading follows the reusable request prefix and does not invalidate existing entries. Each reading does extend the prefix for later steps, which is the intended cost of telling the model something new.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No reading after a turn-concluding tool** — a result carrying `concludesTurn` ends the turn at its step, and any next-step work reopens that boundary to run another model request. Publishing there would buy an extra request to say something the turn no longer needs, so the reading yields to the conclusion. A reading submitted by an earlier sibling in the same batch stays.
- **No reading between an assistant call and its own results** — a single step whose tools balloon the context is reported on the following step. Closing it needs a surface producer outside the tool pipeline.
- **No subagent roll-up** — each agent's reading covers its own surface; a parent does not see a child's consumption.
- **A missing token meter is not fatal** — the guard warns once and publishes nothing rather than failing the turn.
- **The percentage depends on route metadata** — models whose route publishes no window get the count only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The [context pressure Agent Note](../../../.agents/notes/implemented/feature/2026-10-27-context-pressure-reminder.md) records the decision and the rejected alternatives: a model-called tool, a dedicated session event, a blocking decision, threshold-triggered publication, and always-rendered percentages.

</details>
