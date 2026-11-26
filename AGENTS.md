# AGENTS.md — opencode-plugin-provider-queue

Standalone OpenCode 2 server plugin: opt-in per-provider/per-model HTTP
request serialization for self-hosted LLM backends. Packaged like the sibling
repos `opencode-plugin-searxng` / `opencode-plugin-artifacts`.

## Repo map

- `src/index.ts` — the entire plugin. Single entrypoint (`exports: {".":
  "./src/index.ts"}`), loaded as TypeScript source by OpenCode — no build step.
- `test/*.test.mts` — node test runner (`npm test`); typecheck with
  `npm run typecheck` (tsconfig covers `src/` only, Node strips types for tests).
- `docs/superpowers/` — design spec and plan for the packaging work.

## Non-negotiable constraints

### Config parsing: keep reading the files yourself
OpenCode's provider registry strips unknown keys from `settings` before any
plugin can see them, and `concurrency` is such a key. The plugin parses the
config documents directly
(`configFilesFor`/`readConfigFile`/`mergeLimits`/`limitsFor`). Do **not**
"clean this up" by switching to plugin-facing config APIs (`ctx.config` and
friends) — the value will simply not be there. The discovery chain and its
precedence (global < direct project configs far→near < `.opencode/` configs
far→near < system dir) mirror OpenCode's own merge order; match it exactly if
upstream changes. Model-level beats provider-level; `null` clears; invalid
values are ignored (leave the inherited entry intact).

### Ticket invariants (`http.request` / `http.response` / `retry`)
- Every request that acquires a ticket must release exactly one slot: stream
  end, stream error, stream cancel, retry-before-body, or the lease watchdog.
- Hooks do not carry request identity, so responses bind to the oldest
  still-open ticket (`openTicket`). Preserve this pairing when touching
  `httpResponse` or `retry` — with limits > 1, mismatches shift slot
  ownership but must never change the slot count.
- `retry` must only reclaim tickets that never saw a response body
  (`excludeResponded`); tickets of running streams release themselves when
  their stream terminates. Double-releasing a running stream's ticket
  corrupts the count.
- `release()` grants the next waiter synchronously; `openTicket` looks only
  at `held` (released tickets are removed from it).
- A request interrupted while queued never resumes: OpenCode abandons the
  `http.request` await, so no `http.response`, `retry`, or body `cancel` will
  ever fire for it. `interruptSession` (driven by the
  `session.execution.interrupted` event) must drop that session's pending
  waiters and release a ticket granted to it that has not seen a response.
  Without it, the interrupted request takes a slot nobody releases and every
  later request waits out the 15-minute lease. Do not replace this with a
  `request.signal` listener: the hook's `Request` is rebuilt by OpenCode and
  its signal is not tied to session interruption.

### Module-scope state is intentional
The server is one process; `queues` is shared across locations, sessions,
subagents, and projects. That is the desired semantics (the backend's
capacity is global). TTL caches (`limitsCache`, `configCache`) are how config
edits get picked up without restarts — keep them per-request-path cheap.

### Logging
- Append to `~/.local/share/opencode/log/provider-queue.log`; plugin stdout
  is not captured by the detached service. Logging must never throw.
- `OPENCODE_PROVIDER_QUEUE_DEBUG=1` gates per-request debug lines.
- The `loaded for <dir> providers=[...] models=[...]` line on setup is the
  operational signal that the plugin (and only one copy of it) loaded — do
  not remove or reformat it.

### Compatibility
- V2-native provider packages only. The deprecated `aisdk:` runtime does not
  route through these hooks; providers using it are silently unqueued. Do
  not try to "fix" that by patching fetch or the SDK.
- Hook payload types come from `@opencode/plugin`; `RetryEvent.kind` is
  optional because the SDK's retry input has no `kind` (and the retry
  handler never reads it).

## Commands

```sh
npm run typecheck   # tsc --noEmit over src/
npm test            # node --experimental-strip-types --test test/*.test.mts
```

Every test file must keep `import "./bootstrap.mts"` as its first import of
project code: the bootstrap redirects `HOME` to a temp fixture so the
plugin's `log()` (which resolves `LOG_PATH` from `homedir()` at module load)
can never append to the real `~/.local/share/opencode/log/provider-queue.log`
— that file is the human operational signal, including the per-location
`loaded for` single-load line. Tests that read config use an
`XDG_CONFIG_HOME` fixture — never the real `~/.config/opencode`.

Every test must also release every ticket it acquires: a leaked ticket leaves
an armed 15-minute lease timer that stalls the test process after the last
assertion.

## Release flow

Merge to `main` and push to GitHub — consumers pull the plugin over
`git+https` and reload their config; there is no npm publish or build artifact.
The household consumer is `~/Work/sync/setup` (`templates/opencode.json.j2`
plugins entry, deployed via ansible-pull). The plugin `id` is
`"provider-queue"` and its key shapes (`provider/*`, `provider/model`) are
part of the log/config contract.
