# Design: packaging provider-queue as a standalone OpenCode 2 plugin

Date: 2026-11-21
Status: approved (2026-11-21)
Reference: `~/Work/sync/opencode-plugin-searxng` (packaging pattern),
`~/Work/sync/setup` (migration source)

## Purpose

`provider-queue` currently exists only as a Jinja template in the Ansible setup
repo that is written directly to `~/.config/opencode/plugins/provider-queue.js`
on every apply. This design extracts it into a standalone, versioned OpenCode 2
plugin repository, installed like the sibling plugins
(`opencode-plugin-searxng`, `opencode-plugin-artifacts`) via a `git+https`
entry in the global config, and removes Ansible's direct role in deploying the
plugin code.

Success criteria:

- The plugin loads on this machine from the packaged repo, not from a
  templated file; the legacy file no longer exists.
- Behavior is unchanged: provider/model `settings.concurrency` stanzas still
  serialize model HTTP requests exactly as before.
- The setup repo no longer templates plugin code; it only manages config and a
  cleanup task that removes the legacy file everywhere the setup runs.

## Background: current state

- `setup/templates/opencode-plugin-provider-queue.js.j2` — plain JS (~400
  lines, no actual Jinja variables), deployed by
  `setup/tasks/opencode.yml` to `~/.config/opencode/plugins/provider-queue.js`.
- Mechanism: the plugin hooks `http.request` / `http.response` / `retry` in
  OpenCode's server, awaiting a FIFO ticket per queue key
  (`provider/model` or `provider/*`) so a configured provider or model sees a
  bounded number of in-flight requests. Slots are held for the whole streamed
  generation; a 15-minute lease watchdog force-releases stuck tickets.
- Config source: OpenCode's provider registry strips unknown keys from
  `settings` before plugins can read them, so the plugin parses the config
  documents itself, walking the documented discovery chain (global → project
  ancestors → system directory; managed preferences are not read). A
  model-level `concurrency` overrides the provider-level one; `null` clears.
- Logging: appended to `~/.local/share/opencode/log/provider-queue.log`
  (plugin stdout is not captured by the detached service);
  `OPENCODE_PROVIDER_QUEUE_DEBUG=1` logs every intercepted request.
- Limitations that remain true: requires V2-native provider packages (the
  deprecated `aisdk:` runtime does not route through these HTTP hooks);
  queues are module-scope state shared across sessions/projects in the single
  server process.

## Design

### 1. New repository

- Location: `~/Work/sync/opencode-plugin-provider-queue`
- Remote: `https://github.com/StreamOfRon/opencode-plugin-provider-queue`
  (public, created and pushed via `gh repo create` — consistent with siblings).
  Pushing to `main` is a prerequisite for the config migration: OpenCode
  fetches the plugin over `git+https`.
- Layout, mirroring `opencode-plugin-searxng`:

  ```
  package.json
  tsconfig.json
  LICENSE               # MIT, author Ron Miller
  .gitignore            # node_modules, etc.
  README.md
  AGENTS.md
  src/index.ts
  test/                 # runnable with node --experimental-strip-types
  package-lock.json     # committed, as in siblings
  docs/superpowers/specs/   # this spec
  ```

- `package.json` essentials:

  - `name: "opencode-plugin-provider-queue"`, `type: "module"`,
    `version: "0.1.0"`, `license: "MIT"`.
  - `exports: { ".": "./src/index.ts" }`, `files: ["src"]` — OpenCode 2
    loads the TS source directly (same as siblings; no build step).
  - `dependencies: { "@opencode/plugin": "^2.0.15" }`; add
    `@opencode/schema` only if hook payload types are needed.
  - `scripts`: `typecheck` (`tsc --noEmit`), `test` (node strip-types runner).
  - `repository`/`keywords` fields following the searxng file.

### 2. Code conversion (JS → TS)

Mechanical conversion of the template body to `src/index.ts`, with behavior
identical:

- Same `export default Plugin.define({ id: "provider-queue", ... })` shape.
- Same constants, config discovery chain, JSONC parser, limits cache, queue
  acquire/release/watchdog, ticket-to-response binding (oldest open ticket),
  and hooks (`http.request`, `http.response`, `retry`).
- Same log path and `OPENCODE_PROVIDER_QUEUE_DEBUG` behavior.
- JSDoc typedefs become real interfaces/types; the Jinja wrapper is dropped
  (the template has no Jinja variables).
- No new features. Explicitly out of scope: plugin `options` stanza for
  limits, a build/bundle step, npm registry publication.

### 3. README.md

Sections:

- What it does and why (single-GPU/self-hosted backends degrade under
  concurrent streams; opt-in serialization per provider or model).
- Install: add to `plugins` in `opencode.json(c)`:
  `"opencode-plugin-provider-queue@git+https://github.com/StreamOfRon/opencode-plugin-provider-queue.git"`
  (plus a local-path variant for development).
- Configuration: `providers.<id>.settings.concurrency` (provider-wide) and
  `providers.<id>.models.<model>.settings.concurrency` (per-model, wins);
  `null` clears an inherited limit. Concrete snippet.
- How it works: hooks, FIFO tickets, whole-stream slot holding, lease
  watchdog, config file parsing and why (`settings` keys are stripped before
  plugins see them), discovery chain and precedence.
- Logging and debugging: log file path, `OPENCODE_PROVIDER_QUEUE_DEBUG=1`.
- Limitations: V2-native provider packages only (not `aisdk:`); queues shared
  across all sessions/projects in one server process; response-to-ticket
  binding is by age, not identity.
- Development: clone locally, reference by absolute path in `plugins`,
  `npm run typecheck && npm test`.

### 4. AGENTS.md

Concise guidance for agents editing this repo:

- Repo map and the one entrypoint (`src/index.ts`), test commands.
- The load-bearing constraint: do not replace direct config-file parsing with
  plugin-facing config APIs — the provider registry strips unknown `settings`
  keys (`concurrency`) before plugins can read them.
- Hook invariants: every request that acquires a ticket must release exactly
  one slot (stream end / error / cancel / retry-before-body / watchdog);
  responses are bound to the oldest open ticket because hooks do not carry
  request identity — preserve this pairing when touching `http.response` or
  `retry`.
- Module-scope queue state is intentional (single server process shares queues
  across locations); config reloads are picked up via the TTL caches.
- Release flow: merge to `main`, push to GitHub; consumers reload config — no
  publish step. Consumers in this house: `setup/templates/opencode.json.j2`.

### 5. Tests

Node built-in test runner with `--experimental-strip-types` (sibling pattern),
covering the pure/queue logic:

- JSONC parser: comments (line/block), trailing commas, strings containing
  comment-like text and escapes.
- Config discovery: precedence chain (global < ancestors near-to-far <
  `.opencode` variants < system), model-over-provider, `null` clears,
  invalid values ignored.
- Queue: FIFO order, limit > 1 slot accounting, release wakes waiter, limit
  changes take effect as slots free, watchdog force-release path (with an
  injectable/short lease for testability), double-release is a no-op.
- Hook integration smoke: simulated `http.request`/`http.response`/`retry`
  event sequences acquire/release correctly, unqueued providers pass through.

If a hook-level test proves impractical outside the real server, extract the
hook callbacks into testable functions rather than weakening coverage.

### 6. Setup repo migration (`~/Work/sync/setup`)

1. `templates/opencode.json.j2`: add
   `"opencode-plugin-provider-queue@git+https://github.com/StreamOfRon/opencode-plugin-provider-queue.git"`
   to the `plugins` array (string form — no options needed).
2. `tasks/opencode.yml`: replace the "Manage opencode provider-queue plugin"
   template task with a task ensuring
   `~/.config/opencode/plugins/provider-queue.js` is `state: absent`. This
   converges every machine using the setup and prevents the packaged plugin
   and legacy inline copy from loading two queues for the same requests.
3. Delete `templates/opencode-plugin-provider-queue.js.j2`.
4. `tasks/ai-dev-tools.yml`: drop the stale `provider-queue.js` entry from the
   group-disabled removal list (covered unconditionally by step 2).
5. Verify: `ansible-playbook --syntax-check -i localhost, main.yml`,
   `ansible-lint` on changed files,
   `python3 -m unittest tests.test_setup_config tests.test_playbook`.
6. Commit and push to `main` on `https://github.com/StreamOfRon/setup.git`.

### 7. Local apply and verification

1. Create + push the plugin repo (prerequisite for the fetch).
2. Apply via the normal mechanism on this machine: a full `run-ansible-pull.sh`
   run (the playbook entry point `main.yml`, which imports
   `tasks/ai-dev-tools.yml` → `tasks/opencode.yml`), so:
   - global `opencode.json` gains the plugin entry and converges the known
     small drift (one stale permissions block),
   - the legacy `plugins/provider-queue.js` is removed.
3. Verification:
   - `~/.config/opencode/plugins/provider-queue.js` absent;
   - OpenCode fetches/loads the packaged plugin — exactly one `loaded for`
     line per reload in `provider-queue.log` listing the expected limits
     (`tiiny-local/*:1`, `tiiny-network/*:1`, and the three
     `litellm/llamaswap/*:1` model entries);
   - a concurrent request pair against a queued provider serializes (second
     request logs a slot wait), e.g. via `OPENCODE_PROVIDER_QUEUE_DEBUG=1`.

## Orderings and risks

- Push-before-apply: a config entry pointing at a missing remote would make
  plugin loading fail on next reload; the packaged fetch happens at load time.
- Double-load window: between config gaining the entry and the legacy file
  being deleted there is a brief window with both copies loaded (each with
  its own queue state). The same ansible run fixes both, and OpenCode applies
  config changes atomically at reload; worst case is duplicated log lines
  until convergence. Acceptable.
- Rollback: restore the deleted template + task in setup and remove the
  plugins entry; nothing in the plugin repo is required for rollback.

## Non-goals

- Changing queueing behavior, hook mechanics, or log format.
- Supporting the deprecated `aisdk:` runtime.
- Publishing to the npm registry.
- Per-plugin `options` configuration channel.
