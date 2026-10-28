---
description: "Loop-hygiene guard that reports the session's context size to the model on every tool step, for users and maintainers deciding whether the model should see its own token pressure."
kind: "package-reference"
---

# @deepseek-ai/dsh-context-pressure-reminder

English | [中文](README.zh.md)

## Summary

The harness measures the request it is about to send on every step, and until now only compaction consumed that number: the model learned its context was full when compaction deleted the middle of its history. `dsh-context-pressure-reminder` gives the model the number before that happens. After each tool step it appends one line to the next step's context — `[context: ~48.2k tokens]`, plus a window-relative percentage when the routed model publishes a context window — so the model can read less, write findings to a file instead of into the transcript, or delegate, while there is still room. The reading is advice: it carries no instruction, names no threshold, and never blocks a tool call.

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

Invalid configuration fails at load — a negative `minDeltaRatio`, a negative or non-integer `precision`, or an unknown `unit` throws instead of silently changing behavior. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-context-pressure-reminder) documents every accepted value.

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

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Report, never prescribe.** The guard publishes a measurement. Tactics (compact, prune, delegate, stop reading) belong to the model and to compaction's own policy; a guard that named them would duplicate `thresholdRatio` under a different name.
- **Fold onto the downstream decision.** The listener calls `next()` first and appends to whatever came back, so a later listener's `block` still blocks and a later `accept` keeps its own contexts, with the reading placed before them.
- **Measure through the shared meter.** `ctx.tokenMeter.measure()` is the same call compaction makes, so both agree on what pressure means.
- **Fail loud at load.** `precision`, `minDeltaRatio`, and `unit` validate in `apply`.

### Where it hooks

`tools/post-execute` runs after each tool result is durable and before the next step is claimed. The listener measures once per step, applies the debounce against that agent's last published reading, and returns `{ kind: 'accept', additionalContexts: [message] }`. The loop's active-batch FIFO merges the context into the next step's inbox, which splices it onto the surface as a `user/message` with source `{ kind: 'plugin', plugin: 'context-pressure-reminder', form: 'notice', summary: 'context pressure' }`.

That path is why the guard adds no session event and no second surface producer: the reading is model-visible input, so it must be logged and reconstructable, and the loop's own splice already guarantees both.

Parallel calls in one step share one reading — the debounce is keyed per agent and the measurement describes the step, not the call.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, the post-execute listener |
| [`src/pressure.ts`](src/pressure.ts) | Pure rendering and debounce decisions |
| [`src/internal.ts`](src/internal.ts) | Shared internal types |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant: the baseline map is private to one listener) |

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

One extra user-role message after a tool step that moved the measurement:

```markdown
[context: ~48.2k tokens]
```

or, when the route publishes a window:

```markdown
[context: ~48.2k/200k tokens · 24%]
```

#### Token effect

Roughly ten tokens per published reading, once per step that crossed `minDeltaRatio`. No tool schema is added and no normal-call text changes.

#### KV Cache effect

Append-only; the reading follows the reusable request prefix and does not invalidate existing entries. Each reading does extend the prefix for later steps, which is the intended cost of telling the model something new.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

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
