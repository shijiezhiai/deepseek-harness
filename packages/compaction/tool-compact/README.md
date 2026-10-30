---
description: "The model-facing compact_context tool: how a model asks for condensation, what it reads back, and how the backend answers."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-compact

English | [中文](README.zh.md)

## Summary

`dsh-tool-compact` gives the model the one party's view no automation has: it decides when the conversation it is carrying no longer matches what it needs. The `compact_context` tool lets it say so mid-turn, and the condensation backend answers on the next step with a notice describing what was folded. Every compaction before this was triggered by occupancy, by a provider rejecting an over-long request, or by a person typing `/compact`.

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

Mount the package beside a backend that serves requests. The shipped `dsh` base mounts it next to `compaction-basic`, so it is usually already available.

### Using the tool

| Input | Result |
|---|---|
| `compact_context()` | The call returns `requested`; condensation runs before the next turn step and the model reads what was folded. |
| `compact_context({ focus })` | The same, with the focus recorded on the call. A backend that cannot pass a focus through still condenses. |
| Nothing worth folding | The request is declined and the model is told why; the conversation is unchanged. |

### What the model reads

The tool result itself carries no analysis — it acknowledges the request. The answer arrives on the following step as an ordinary user message, so it is part of what the model reconstructs from the log:

| Situation | Notice |
|---|---|
| Condensed | How many history items were folded into the summary, and the estimated tokens reclaimed. |
| Declined, surface too small | The conversation is below the occupancy floor where condensing would delete state the model still needs. |
| Declined, limit spent | This turn has already used its model-requested compactions. |
| Declined, already condensed this turn | Something condensed this turn without the model asking; the surface the model measured is not the one it is looking at. |

Each notice is written once. A declined request is not repeated on every following step.

### Composing the tool

Mount the tool and a backend that serves it:

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
- id: tool-compact
  name: '@deepseek-ai/dsh-tool-compact'
```

A composition that mounts the tool without a serving backend keeps `compact_context` visible in the tool list but never answers it. Set `serveRequests: false` on `compaction-basic` to make that deliberate when the tool is mounted for another reason.

### Tuning the gates

`compaction-basic` owns both gates; the tool has no configuration.

| Field | Default | Effect |
|---|---|---|
| `requestPolicy.minContextRatio` | `0.10` | Lowest occupancy, as a fraction of the window, at which a request is served. |
| `requestPolicy.maxPerTurn` | `2` | Model-requested compactions permitted in one turn. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains why the package is split this way; the observable behavior is covered in [Use this package](#use-this-package).

### Design philosophy

The tool and the backend are one seam with two halves, and they never share state:

- **The request is the tool call.** There is no separate request event. `request.ts` folds `tool/call` events out of the durable log to find a `compact_context` call the backend has not answered, which keeps the request reconstructable from the log alone.
- **The tool declares `deferContext`.** The loop records that the call will be followed by context the model did not derive itself, which is what lets the notice arrive as a user message without being treated as model-authored.
- **The Service Definition stays untouched.** `CompactionEngine` gains nothing; the backend implements request serving as a private method reached through its existing `agent/pre-step` listener.

### Answering once

`agent/pre-step` runs before each request. The backend claims at most one outstanding request per turn, and marks it answered before condensing, so a step that condenses and a step that declines both produce exactly one notice. Answering is keyed on the turn: a new `turn/start` retires whatever the previous turn left unanswered.

A request is refused before the summarizer is touched when the measured occupancy is below `minContextRatio`, when `maxPerTurn` is spent, or when this turn already recorded a compaction the model did not ask for. That last gate needs no timestamp and no threshold: an automatic compaction in the same turn is itself the evidence that the surface changed under the model.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `compact_context` registration, input validation, presentation |
| [`src/request.ts`](src/request.ts) | Log fold that finds an unanswered request and retires it at turn boundaries |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Compaction seam](../compaction/README.md) — the condensation contract this tool requests.
- [Compaction basic backend](../compaction-basic/README.md) — the shipped backend that serves the request.
- [Context pressure reminder](../../guard/context-pressure-reminder/README.md) — the reading that tells a model its context size before it decides to ask.
- [Model-initiated compaction Agent Note](../../../.agents/notes/implemented/feature/2026-10-29-model-initiated-compaction.md) — the three gates and why the Service Definition stayed unchanged.

-----

<a id="model-experience"></a>
## Model Experience

### Deciding to condense

#### What the model sees

The tool definition, its own `compact_context` call, the tool result acknowledging it, and the notice on the following step. The notice is an ordinary user message that names what was folded or why nothing was.

#### Token effect

The tool result is a few tokens. A successful compaction replaces an older span with one framed summary, which reduces every later request; the summarization is one auxiliary request. Declined requests cost one short notice.

#### KV Cache effect

Discovery costs nothing. The accepted surface replacement invalidates reuse from the first shadowed history token, which is the same cost as any other compaction.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Focus is recorded, not delivered** — `focus` travels on the tool call and reaches presentation, but `compactRegion` cannot yet forward a focus to the summarizer, so the summary is not steered by it.
- **Serving requires a backend** — the tool does not condense anything itself; a composition must mount a backend that serves requests.
- **One request per turn boundary** — a request claimed by a turn that ends before the next step is retired unanswered.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above, the package code, and the linked Agent Notes.

- **Delivering focus, undecided** — forwarding a focus needs a summarizer input field owned by the backend; the tool already records it.
- **Gate tuning, open** — the `0.10` floor and `2`-per-turn limit are unmeasured starting points, chosen so a request cannot delete the working set or loop.

</details>
