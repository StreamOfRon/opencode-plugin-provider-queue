# provider-queue Standalone Plugin Packaging — Implementation Plan

**Goal:** Extract the Ansible-templated `provider-queue` OpenCode plugin into a standalone TypeScript plugin repo at `~/Work/sync/opencode-plugin-provider-queue`, published on GitHub, and switch local config to install it via `git+https` while Ansible stops writing the code.

**Architecture:** One-package OpenCode 2 server plugin: `src/index.ts` exports the plugin via `Plugin.define` plus named symbols for testability (parsers, config discovery, queue, and a `buildHandlers` factory the hooks delegate to). The setup repo keeps only config management: a `plugins` entry in `templates/opencode.json.j2` and an idempotent `state: absent` cleanup of the legacy inline file.

**Tech Stack:** TypeScript (strict, no build step — loaded as source by Node 26 type-stripping), `@opencode/plugin` ^2.0.15, Node built-in test runner (`node --experimental-strip-types --test`), Ansible + `unittest` for the setup side.

**Spec:** `docs/superpowers/specs/2026-11-21-provider-queue-plugin-packaging-design.md` (this repo)

## Global Constraints

- Behavior is a faithful port of `~/Work/sync/setup/templates/opencode-plugin-provider-queue.js.j2` (read it in full before Task 2). Constants verbatim: `LEASE_MS = 15 * 60 * 1000`; `MODEL_KINDS = {primary, compaction, title, generate}`; `CONFIG_TTL_MS = 5000`; `LOG_PATH = ~/.local/share/opencode/log/provider-queue.log`; env `OPENCODE_PROVIDER_QUEUE_DEBUG=1`; plugin `id: "provider-queue"`.
- No new features: no plugin `options` channel, no build step, no npm publication, no `aisdk:` support (spec Non-goals).
- Packaging mirrors `~/Work/sync/opencode-plugin-searxng`: `package.json` fields (`type: "module"`, `exports: { ".": "./src/index.ts" }`, `files: ["src"]`), `tsconfig.json` (copy verbatim), `.gitignore` (copy verbatim), MIT LICENSE (copy, year 2026, author Ron Miller), committed `package-lock.json`.
- Commits: small, one logical change each, imperative subject ("Add …", "Port …", "Drop …").
- The plugin repo must be pushed to GitHub **before** the local apply (Task 7), and the setup repo must be pushed to `main` before `run-ansible-pull.sh` can converge (it pulls from GitHub).

## Review Focus

Failure modes the spec implies but per-task tests may not reach — pin each with the named test:

1. Malformed/invalid JSONC config files must be skipped with a log line, never throw and never disable other files → `test("unparseable config files are skipped")` (Task 3).
2. `concurrency: null` clears an inherited limit; `0`, `"abc"`, `NaN` are ignored (not treated as unlimited or zero) → `test("invalid concurrency values are ignored, null clears")` (Task 3).
3. A response with no body (error/no-stream) must release its ticket immediately, not leak a slot → `test("response without body releases the ticket")` (Task 4).
4. The packaged plugin and the legacy inline copy must not both load → Task 6 cleanup task + `test("legacy inline plugin file absent after apply")` (Task 7 verification).
5. `aisdk:` providers (e.g. `lemonade`) never reach these hooks and must pass through unqueued → `test("unqueued providers pass through")` (Task 4).

---

### Task 1: Repo scaffold on GitHub

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`
- (Already present: `docs/superpowers/specs/2026-11-21-...-design.md`)

**Interfaces:**
- Produces: a git repo on branch `main` with remote `origin` = `https://github.com/StreamOfRon/opencode-plugin-provider-queue` (public), and a `package.json` whose `scripts.typecheck` / `scripts.test` later tasks rely on: `"typecheck": "tsc --noEmit"`, `"test": "node --experimental-strip-types --test test/*.test.mts"`.

- [ ] **Step 1: Write `package.json`** — copy the searxng one at `~/Work/sync/opencode-plugin-searxng/package.json` and change only: `name` → `opencode-plugin-provider-queue`; `description` → `"Per-provider/per-model request serialization for OpenCode V2"`; `repository.url` → `git+https://github.com/StreamOfRon/opencode-plugin-provider-queue.git`; `keywords` → `["opencode", "opencode-plugin", "provider-queue", "concurrency", "serialization"]`; drop runtime deps not used here (keep `@opencode/plugin` ^2.0.15; add `@opencode/schema` ^2.0.15 only if Task 2 needs hook types — start without it). Dev deps and scripts per Interfaces.
- [ ] **Step 2: Copy `tsconfig.json`, `.gitignore`, `LICENSE` verbatim from searxng** (LICENSE unchanged: same MIT text, author line).
- [ ] **Step 3: Install and lock deps** — `npm install` in the repo. Expected: `package-lock.json` created, `node_modules/@opencode/plugin` present.
- [ ] **Step 4: Commit** — `git add package.json tsconfig.json .gitignore LICENSE package-lock.json && git commit -m "Add package scaffold mirroring sibling plugin repos"`.
- [ ] **Step 5: Create and push the GitHub repo** — `gh repo create StreamOfRon/opencode-plugin-provider-queue --public --source . --remote origin --push`. Expected: repo exists, `git log origin/main` shows the spec + scaffold commits. This satisfies the push-before-apply ordering early; later pushes are additive.

### Task 2: Port the plugin to `src/index.ts`

**Files:**
- Create: `src/index.ts`
- Reference (read-only): `~/Work/sync/setup/templates/opencode-plugin-provider-queue.js.j2`

**Interfaces:**
- Consumes: nothing (port of the template).
- Produces named exports used by Tasks 3–4 and the default plugin:
  - `parseJsonc(text: string): unknown`
  - `mergeLimits(docs: readonly unknown[]): Limits` where `Limits = { providers: Map<string, number>; models: Map<string, number> }` (docs in ascending precedence — the per-file provider/model walk of the template's `limitsFor`)
  - `configFilesFor(locationDirectory: string): string[]`
  - `limitsFor(locationDirectory: string): Limits` (TTL caches as today)
  - `parseConcurrency(value: unknown): number | null | undefined`
  - `selectQueue(limits: Limits, model: { providerID: string; id: string } | undefined): QueueSel | undefined` where `QueueSel = { key: string; limit: number }`
  - `type Ticket = { done: boolean; sawResponse: boolean; timer: ReturnType<typeof setTimeout> | null }`
  - `queueFor(key: string, limit: number): Queue` — module-scope `queues: Map<string, Queue>`; `Queue = { key: string; limit: number; active: number; waiters: Array<() => void>; held: Ticket[] }`
  - `acquire(q: Queue, leaseMs?: number): Promise<Ticket>` — added optional `leaseMs` **defaults to `LEASE_MS`** (testability only; behavior identical)
  - `release(q: Queue, ticket: Ticket): void`
  - `openTicket(q: Queue, opts?: { excludeResponded?: boolean }): Ticket | undefined`
  - `buildHandlers(deps: { locationDirectory: string }): { httpRequest(e: HttpReqEvent): Promise<void>; httpResponse(e: HttpRespEvent): void; retry(e: RetryEvent): void }` — holds the `sessionSelections` map and body-wrapping logic; `HttpRespEvent = { kind: string; model?: ...; sessionID: string; response: Response }`, `RetryEvent = { kind: string; model?: ...; sessionID: string; attempt: number }`, `HttpReqEvent = { kind: string; model?: ...; sessionID: string }`
  - `export default Plugin.define({ id: "provider-queue", async setup(ctx) { ... } })` — `setup` registers `buildHandlers` outputs on `ctx.session.hook("http.request" | "http.response" | "retry")` and logs the `loaded for ...` line verbatim to the template.

- [ ] **Step 1: Port module header and pure functions** — top-of-file comment block (adapted: it is now a published plugin, not a templated file), imports (`node:fs`, `node:os`, `node:path`, `@opencode/plugin`), constants verbatim, `log`, config discovery (`configDirCandidates`, `globalConfigDirectory`, `systemConfigDirectory`, `configFilesFor`), `parseJsonc`, `parseConcurrency`, `readConfigFile`, `mergeLimits`, `limitsFor`, queue (`queues`, `queueFor`, `acquire`, `release`, `openTicket`), `selectQueue`. Convert JSDoc typedefs to interfaces; type hook payloads loosely (`event.model?: { providerID: string; id: string }` etc.). Preserve every branch — especially `null`-clears / `undefined`-ignores in `mergeLimits` and the oldest-open-ticket binding comment.
- [ ] **Step 2: Extract `buildHandlers`** — move the three hook bodies out of `setup` into the factory exactly as listed; `setup` becomes: resolve `locationDirectory`, build handlers, register hooks, log loaded line. No behavior deltas; the only signature change anywhere is `acquire(q, leaseMs = LEASE_MS)`.
- [ ] **Step 3: Add `src/` to typecheck and run it** — `npm run typecheck`. Expected: PASS (fix any strict-mode issues locally without changing runtime behavior; e.g. `noUncheckedIndexedAccess` is off in the sibling tsconfig, so indexing stays simple).
- [ ] **Step 4: Commit** — `git add src/index.ts package.json package-lock.json && git commit -m "Port provider-queue plugin to TypeScript"`.

### Task 3: Parser, discovery, and limits tests

**Files:**
- Create: `test/config.test.mts`
- Consumes: Task 2 named exports.

- [ ] **Step 1: Write the tests** (all must pass immediately — this is a characterization suite of the port; if any fails, the port changed behavior and Task 2 must be fixed):
  - `parseJsonc`: plain JSON; line comments; block comments; trailing commas; `"// not a comment"` inside a string survives; escaped quotes survive; **`test("unparseable config files are skipped")`** — for garbage input `parseJsonc` throws, and `limitsFor` over a dir containing such a file returns limits from the other files (construct via `XDG_CONFIG_HOME` fixture dir + a temp project dir; assert no throw and expected map).
  - `configFilesFor`: given a project dir two levels deep, returns global first, then ancestors→near→far direct configs, then `.opencode` variants far→near, then system dir last (assert on path strings, computed with the same helpers).
  - `parseConcurrency`: `1→1`, `"2"→2`, `2.7→2`, `null→null`, `0→undefined`, `"abc"→undefined`, `undefined→undefined`.
  - `mergeLimits`: provider stanza sets `provider/*`; model stanza beats provider; **`test("invalid concurrency values are ignored, null clears")`** — a later doc with `concurrency: null` deletes an earlier provider/model entry; invalid values leave the earlier entry intact.
  - `selectQueue`: model match wins over provider; `provider/*` key shape vs `provider/model` key shape; missing model/providerID → `undefined`.
- [ ] **Step 2: Run** — `npm test`. Expected: PASS (fix the port, not the tests, on failure).
- [ ] **Step 3: Commit** — `git add test/config.test.mts && git commit -m "Add config parsing and discovery characterization tests"`.

### Task 4: Queue and hook integration tests

**Files:**
- Create: `test/queue.test.mts`, `test/hooks.test.mts`

**Interfaces:**
- Consumes: Task 2 exports (`buildHandlers` especially). `buildHandlers` reads live config via `limitsFor(locationDirectory)` — tests set `XDG_CONFIG_HOME` to a fixture dir containing an `opencode.json` with e.g. `providers: { testp: { settings: { concurrency: 1 } } }` and pass a temp location dir. `test("unqueued providers pass through")` uses provider `otherp` (absent from config) per Review Focus #5.

- [ ] **Step 1: Queue unit tests** (`test/queue.test.mts`):
  - FIFO: with limit 1, second `acquire` resolves only after first `release`; waiters resolve in order with three queued.
  - limit > 1: two concurrent holds allowed; `release` of one wakes exactly one waiter.
  - double `release` on same ticket is a no-op (active count unchanged).
  - limit change via `queueFor(key, newLimit)` takes effect as slots free (raise then lower).
  - watchdog: `acquire(q, 20)`; after >20ms and one event-loop turn, the ticket is force-released and a waiting `acquire` resolves.
- [ ] **Step 2: Hook integration tests** (`test/hooks.test.mts`), driving `buildHandlers` results with synthetic events:
  - `httpRequest` for `testp` model with kind `primary` blocks while a prior ticket is held (assert pending promise + queue `active === 1`), then `httpResponse` with a one-chunk `ReadableStream` body releases after the stream is fully read (assert via drain + resolved acquire).
  - `httpResponse` stream **error** path releases; **cancel** path releases.
  - **`test("response without body releases the ticket")`** — `event.response = new Response(null, { status: 204 })`-style bodyless response → slot free immediately.
  - `retry` after a request that never saw a response releases the pre-body ticket; retry after `sawResponse` does not double-release (Review Focus pairing comment).
  - **`test("unqueued providers pass through")`** — `otherp` request returns without touching any queue; its `httpResponse` is a no-op.
  - `kind: "other"` events are ignored entirely.
- [ ] **Step 3: Run** — `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 4: Commit** — `git add test/queue.test.mts test/hooks.test.mts && git commit -m "Add queue lifecycle and hook integration tests"`.

### Task 5: README.md and AGENTS.md

**Files:**
- Create: `README.md`, `AGENTS.md`

- [ ] **Step 1: Write `README.md`** following spec §3 exactly (sections: What & why; Install with the `git+https` plugins entry plus local-path dev variant; Configuration with a concrete `providers` snippet showing provider-level and model-level `concurrency` and `null` clearing; How it works incl. *why the plugin parses config files itself* — registry strips unknown settings keys — and the discovery/precedence chain; Logging & debugging; Limitations (V2-native packages only / `aisdk:` silently unqueued, module-scope shared queues, age-based response-ticket binding); Development (`npm run typecheck && npm test`, reference by absolute path while iterating)).
- [ ] **Step 2: Write `AGENTS.md`** following spec §4: repo map; the "do not replace direct config parsing" constraint; hook/ticket invariants (exactly-one-release; oldest-open-ticket binding; watchdog last resort); module-scope queues + TTL caches are intentional; release flow = push to `main`, consumers reload (name the consumer `setup/templates/opencode.json.j2`); test/typecheck commands.
- [ ] **Step 3: Commit and push** — `git add README.md AGENTS.md && git commit -m "Add README and AGENTS docs" && git push`.

### Task 6: Setup repo migration

**Files:**
- Modify: `~/Work/sync/setup/templates/opencode.json.j2` (plugins array, lines 4–14)
- Modify: `~/Work/sync/setup/tasks/opencode.yml` (template task, lines 19–23)
- Delete: `~/Work/sync/setup/templates/opencode-plugin-provider-queue.js.j2`
- Modify: `~/Work/sync/setup/tasks/ai-dev-tools.yml` (removal loop entry, line 76)

**Interfaces:**
- Consumes: pushed plugin repo at the `git+https` URL (Task 1/5).

- [ ] **Step 1: Add the plugins entry** — in `templates/opencode.json.j2`, append to the `plugins` array after the artifacts entry:
  ```json
  "opencode-plugin-provider-queue@git+https://github.com/StreamOfRon/opencode-plugin-provider-queue.git"
  ```
- [ ] **Step 2: Replace the template task with a cleanup task** — in `tasks/opencode.yml`, swap the "Manage opencode provider-queue plugin" `template` task for:
  ```yaml
  - name: Remove legacy provider-queue plugin file
    ansible.builtin.file:
      path: "{{ lookup('env', 'HOME') }}/.config/opencode/plugins/provider-queue.js"
      state: absent
  ```
  Keep the plugins *directory* task (other local plugins may live there).
- [ ] **Step 3: Delete the template** — `git rm templates/opencode-plugin-provider-queue.js.j2`.
- [ ] **Step 4: Drop the stale removal entry** — delete line 76 from the loop in `tasks/ai-dev-tools.yml` (`.../plugins/provider-queue.js`); the unconditional Step 2 task now covers every state of the group.
- [ ] **Step 5: Verify** — `ansible-playbook --syntax-check -i localhost, main.yml`; `ansible-lint tasks/opencode.yml tasks/ai-dev-tools.yml`; `python3 -m unittest tests.test_setup_config tests.test_playbook`. Expected: all pass (grep the suite for any provider-queue assumption first — none exist as of writing).
- [ ] **Step 6: Commit and push to main** — `git add -A && git commit -m "Install provider-queue as packaged plugin instead of templating it" && git push origin main`.

### Task 7: Local apply and verification

**Files:** none created.

- [ ] **Step 1: Trigger convergence** — `~/Work/sync/setup/run-ansible-pull.sh`. The quiet sync applies because the GitHub repo changed since last pull. Expected: changed task output for the opencode config template + the legacy-file removal.
- [ ] **Step 2: `test("legacy inline plugin file absent after apply")`** — shell check: `test ! -e ~/.config/opencode/plugins/provider-queue.js` → exit 0. If it exists, the apply didn't converge — investigate before proceeding.
- [ ] **Step 3: Confirm the packaged plugin loads** — `~/.config/opencode/opencode.json` contains the new entry (grep `provider-queue`); then cause/await a reload and check `tail -5 ~/.local/share/opencode/log/provider-queue.log` shows **exactly one** new `loaded for ...` line per reload listing `tiiny-local:1`, `tiiny-network:1` and the three `litellm/llamaswap/*:1` model entries (duplicate lines ⇒ Review Focus #4 violation: legacy copy still loading). If no reload happens on its own, start `opencode` briefly (TUI opens and exits, or `opencode run "hi" -m opencode/big-pickle` against a non-queued model) — plugin load happens at server config discovery.
- [ ] **Step 4: Report** — state observed log lines and that behavior is unchanged (serialization itself is inherited from the port; no live GPU box guarantee at plan time, so a full concurrent-stress check is optional best-effort with `OPENCODE_PROVIDER_QUEUE_DEBUG=1` only if a queued provider is reachable).

## Self-review notes (plan author, 2026-11-21)

- Spec coverage: §1→Task 1, §2→Task 2, §3→Task 5, §4→Task 5, §5→Tasks 3–4, §6→Task 6, §7→Task 7. Ordering/risk section honored via Global Constraints push-before-apply and Task 7 Step 3 duplicate detection.
- The only intentional signature deviation from the template is `acquire(q, leaseMs?)`; flagged in Task 2 Step 2.
