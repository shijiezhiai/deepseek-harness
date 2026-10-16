# Agent Note: Bounded retry schedule for client bundle transports

Status: implemented

English | [中文](2026-10-15-bundle-transport-retry-schedule.zh.md)

## Problem

Installing or updating a plugin rewrites the profile's `node_modules` while the page can already be booting, and a `<script>` request that lands inside that rewrite fails for a reason that no longer holds a moment later. On 2026-10-15 the desktop profile's packages were relinked at 19:51 and the app booted at 19:55: the 33-resource application combo answered unloadably for `dsh-better-sidebar`, and both arrival attempts (the first plus the immediate same-tick retry of `ClientModuleSystem.arrive`) fell inside the same window. `web boot: 2 entries did not activate` then reached the desktop shell, whose recovery dialog offers only "disable third-party plugins" — it resets `dsh.profile.bundles` and backs up `cordis.patch.yml`, so one transient transport failure during a package rewrite cost the user every installed plugin.

## Decision

`ClientModuleSystem.arrive` attempts a bundle URL on the schedule `BUNDLE_RETRY_DELAYS_MS` — immediately, then after 400 ms, then after 1.2 s, so three attempts per URL and at most 1.6 s of waiting.

- **One schedule per URL, shared by every waiting row.** `transportWaves` holds the in-flight schedule per URL, so all rows of a batch, and every row that joins while it retries, share its attempts instead of starting their own. `loadShared` no longer de-duplicates in-flight bundle transports; the wave owns that. Package-local chunk requests keep their own in-flight de-duplication in `pendingChunks`.
- **Only transport failures retry.** A `<script>` `error` event means nothing executed, so a replay cannot register anything twice. A script that loaded without registering its row is never re-executed; the `failedBundleUrls` and `executedBundleUrls` bookkeeping is unchanged.
- **The one-resource fallback uses the same schedule.** A row still missing after the batch falls back to its own one-resource combo URL with the same three attempts, so one failed batch costs at most three requests per URL and leaves registered rows untouched.
- **The per-row error names the count.** A URL whose schedule is exhausted contributes one entry, `<url>: <transport message> (retried 2 times)`, to the failure text that `assertEntriesActive` reports.

The delays are bounded deliberately: the window this closes is a package rewrite that settles within about a second, while an artifact that is genuinely absent must still reach the boot audit instead of stalling it.

## Alternatives considered

**Keep the immediate same-tick retry.** Rejected: both attempts then measure the same rewrite window, which is the defect; only a delayed attempt can see settled artifacts.

**One schedule per row.** Rejected: the rows of a batch would each spend three requests per URL, multiplying requests against an artifact that is already unavailable and making the fetch count depend on row import order.

**More attempts with exponential backoff.** Rejected: coverage grows slowly past the second delay, while every row that cannot load waits longer before the boot audit reports it.

**Retry on the next import instead of on a timer.** Rejected: within one boot the Loader imports each entry once, so a failed row's next chance is its one-resource fallback, and the boot audit fails the entry before any later import.

## Consequences

- A package rewrite that settles within about a second no longer fails the rows waiting on the batch or on its fallback, so a transient failure no longer escalates to the shell's disable-all-plugins dialog.
- The request bound stays at three per URL per schedule, and a row joining an in-flight wave shares its remaining attempts rather than adding requests.
- A row whose artifact never becomes loadable now takes up to 1.6 s before its per-row failure is recorded: the added boot latency for a real failure.
- Two in-flight maps with distinct owners — `transportWaves` for bundle transports and `pendingChunks` for package-local chunks.

## Testing

`packages/client/modules/tests/loader.client.spec.ts` drives the schedule with fake timers: the test `waits before retrying a failed batch and shares the retry across its rows` imports two rows whose batch fails once, asserts a single fetch before the delay, advances the retry window, and asserts two successful rows but no additional fetch from the second row. The exhausted cases assert three fetches per URL and the `retried 2 times` text. `packages/client/modules/tests/entries.client.spec.ts` covers the HMR path, where a stale reload target is retried on the same URL under the same schedule.

## Related

[Fatal diagnostics and crash reports](../architecture/2026-09-22-fatal-diagnostics-and-crash-reports.md) owns the per-row isolation of batch failures, the one-resource fallback, and the boot audit that reports the failing entries.
