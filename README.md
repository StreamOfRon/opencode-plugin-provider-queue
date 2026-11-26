# opencode-plugin-provider-queue

[OpenCode V2](https://opencode.ai/v2/docs/) plugin that serializes model HTTP
requests per provider or per model — opt-in, via a `concurrency` setting in
your normal provider config.

Self-hosted LLM backends that can only process one generation at a time (a
single-GPU vLLM/LiteLLM/Tiiny box) degrade badly under concurrency:
simultaneous streams evict each other's prompt caches and time out. This
plugin queues those requests so a configured provider or model sees a bounded
number of in-flight requests (`1` = strictly serial), while every other
provider keeps OpenCode's default behavior.

## Install

Add it to `plugins` in your global (or project) `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-plugin-provider-queue@git+https://github.com/StreamOfRon/opencode-plugin-provider-queue.git"
  ]
}
```

For development, point at a local clone instead:

```jsonc
{ "plugins": ["/absolute/path/to/opencode-plugin-provider-queue"] }
```

Config changes are picked up without a restart; use `/reload` to force a full
reload.

## Configuration

Activation is per provider and/or per model, in the provider stanzas you
already have:

```jsonc
{
  "providers": {
    "tiiny-local": {
      "settings": {
        "baseURL": "http://api.tiiny/v1",
        "concurrency": 1
      },
      "models": {
        // per-model wins over the provider-level value
        "Qwen/Qwen3.8-27B": { "settings": { "concurrency": 2 } },
        // null clears an inherited limit — this model is never queued
        "some/api-only-model": { "settings": { "concurrency": null } }
      }
    }
  }
}
```

| Setting                    | Values                              | Meaning                                        |
| -------------------------- | ----------------------------------- | ---------------------------------------------- |
| `settings.concurrency` at provider level | integer ≥ 1       | cap on in-flight requests for the whole provider |
| `settings.concurrency` at model level    | integer ≥ 1       | cap for that model; overrides the provider cap |
| `null` anywhere            | —                                   | clears an inherited limit (model unqueued)     |

Invalid values (`0`, negative, non-numeric) are ignored — the inherited value,
if any, stays in effect.

## How it works

- `http.request` hook: awaited FIFO ticket for the request's queue before the
  request is dispatched.
- `http.response` hook: wraps the response body stream; the slot is held for
  the **whole generation** and released when the stream ends, errors, or is
  cancelled — not when headers arrive.
- `retry` hook: reclaims slots from attempts that failed before a response
  body existed.
- `session.execution.interrupted` event: when you cancel an execution, drops
  its still-queued request and frees a slot it took but never used, so a
  cancelled request cannot block the queue.
- A lease watchdog force-releases any ticket older than 15 minutes, so a lost
  stream can never deadlock the queue.

**Why the plugin parses your config files itself:** OpenCode's provider
registry drops unknown keys from `settings` before plugins can read them, and
`concurrency` is one of those keys. The plugin therefore reads the config
documents directly, walking OpenCode's documented discovery chain: global
(`~/.config/opencode/`, honoring `XDG_CONFIG_HOME`) → each project ancestor
directory (farthest first) → the same chain again for `.opencode/` subdirs →
system directory (highest precedence). Managed preferences are not read.
A model-level value overrides the provider-level one; `null` clears.

## Logging and debugging

Queue activity is appended to
`~/.local/share/opencode/log/provider-queue.log` (plugin stdout is not
captured by the detached OpenCode service):

```
... t1p/*: request waiting (in flight=1/1, queued=2)
... t1p/*: slot acquired after 4213ms wait (in flight=1/1, queued=1)
```

Set `OPENCODE_PROVIDER_QUEUE_DEBUG=1` in the server environment to also log
every intercepted request and whether it was queued.

## Limitations

- Requires V2-native provider packages (e.g.
  `@opencode/ai/providers/openai-compatible`). The deprecated `aisdk:`
  runtime does not route through these HTTP hooks — such providers are
  silently unqueued.
- Queues are module-scope state in the single server process: parent
  sessions, subagents, and separate projects share one queue per key. This
  is the point — the backend's capacity is global.
- The hooks do not expose which request a response belongs to, so responses
  are bound to the oldest still-open ticket. With limits above 1 this can
  shift *which* stream owns a slot, but never the slot count.

## Development

```sh
git clone https://github.com/StreamOfRon/opencode-plugin-provider-queue.git
cd opencode-plugin-provider-queue
npm install
npm run typecheck
npm test
```

Reference the clone by absolute path in your `plugins` array to iterate; see
`AGENTS.md` for the invariants to preserve when changing the queueing or hook
logic.
