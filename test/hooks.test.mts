/**
 * Hook integration tests driving buildHandlers with synthetic events
 * (Task 4, Step 2). Run with: npm test
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./bootstrap.mts";
import plugin, { buildHandlers, queues, openTicket, release, interruptSession } from "../src/index.ts";

// Config fixture: every queued provider at concurrency 1; `otherp` absent.
const xdg = mkdtempSync(join(tmpdir(), "pq-hooks-xdg-"));
mkdirSync(join(xdg, "opencode"), { recursive: true });
const providers: Record<string, unknown> = { testp: { settings: { concurrency: 1 } } };
for (const p of ["t1p", "t2p", "t3p", "t4p", "t5p", "t6p", "t7p", "t8p", "t9p"]) providers[p] = { settings: { concurrency: 1 } };
writeFileSync(join(xdg, "opencode", "opencode.json"), JSON.stringify({ providers }));
process.env.XDG_CONFIG_HOME = xdg;

const locationDirectory = mkdtempSync(join(tmpdir(), "pq-hooks-loc-"));
const handlers = buildHandlers({ locationDirectory });

const flush = () => new Promise((r) => setImmediate(r));
const model = (providerID: string) => ({ providerID, id: "m1" });
const req = (providerID: string, sessionID: string) => ({ kind: "primary", model: model(providerID), sessionID });
const queueOf = (providerID: string) => {
  const q = queues.get(`${providerID}/*`);
  assert.ok(q, `queue for ${providerID}/* should exist`);
  return q;
};

function closingStream() {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("hello"));
      c.close();
    },
  });
}

test("httpRequest blocks while the slot is held; release only after the stream is fully read", async () => {
  await handlers.httpRequest(req("t1p", "s1"));
  const q = queueOf("t1p");
  assert.equal(q.active, 1);

  let done2 = false;
  const p2 = handlers.httpRequest(req("t1p", "s2")).then(() => {
    done2 = true;
  });
  await flush();
  assert.equal(done2, false);

  const ev = { ...req("t1p", "s1"), response: new Response(closingStream()) };
  handlers.httpResponse(ev);
  await flush();
  assert.equal(done2, false); // slot still held while the stream is open

  const text = await ev.response.text(); // drain the wrapped stream
  assert.equal(text, "hello");
  await flush();
  assert.equal(done2, true);

  const t = openTicket(q); // cleanup: s2's ticket has no response
  if (t) release(q, t);
});

test("stream error path releases the slot", async () => {
  await handlers.httpRequest(req("t2p", "s1"));
  const q = queueOf("t2p");
  const bad = new ReadableStream({
    start(c) {
      c.error(new Error("boom"));
    },
  });
  const ev = { ...req("t2p", "s1"), response: new Response(bad) };
  handlers.httpResponse(ev);
  await assert.rejects(() => ev.response.text());
  assert.equal(q.active, 0);
  assert.equal(openTicket(q), undefined);
});

test("stream cancel path releases the slot", async () => {
  await handlers.httpRequest(req("t3p", "s1"));
  const q = queueOf("t3p");
  const neverEnds = new ReadableStream();
  const ev = { ...req("t3p", "s1"), response: new Response(neverEnds) };
  handlers.httpResponse(ev);
  assert.equal(q.active, 1);
  await ev.response.body!.cancel();
  assert.equal(q.active, 0);
});

test("response without body releases the ticket", async () => {
  await handlers.httpRequest(req("t4p", "s1"));
  const q = queueOf("t4p");
  const ev = { ...req("t4p", "s1"), response: new Response(null, { status: 204 }) };
  handlers.httpResponse(ev);
  assert.equal(q.active, 0); // released immediately, no drain needed
  assert.equal(openTicket(q), undefined);
});

test("retry reclaims a never-responded ticket but not a running stream", async () => {
  await handlers.httpRequest(req("t5p", "s1"));
  const q = queueOf("t5p");

  // The attempt never got a response body: retry must reclaim the slot.
  handlers.retry({ ...req("t5p", "s1"), attempt: 1 });
  assert.equal(q.active, 0);
  assert.equal(openTicket(q), undefined);

  // The next attempt takes the slot and starts streaming.
  await handlers.httpRequest(req("t5p", "s2"));
  const ev = { ...req("t5p", "s2"), response: new Response(closingStream()) };
  handlers.httpResponse(ev);
  assert.equal(q.active, 1);

  // A retry while the stream is running must NOT double-release: the
  // running ticket is excluded, so there is nothing to reclaim.
  handlers.retry({ ...req("t5p", "s2"), attempt: 2 });
  assert.equal(q.active, 1);

  // The stream itself owns the release.
  await ev.response.text();
  assert.equal(q.active, 0);
});

test("model-less response falls back to the session's last queued selection", async () => {
  await handlers.httpRequest(req("testp", "fb1"));
  const q = queueOf("testp");
  assert.equal(q.active, 1);

  // Some hook events omit `model` entirely; the session's queued selection
  // must carry the pairing so the stream still owns and releases the slot.
  const ev: { kind: string; sessionID: string; response: Response } = {
    kind: "primary",
    sessionID: "fb1",
    response: new Response(closingStream()),
  };
  handlers.httpResponse(ev as never);
  assert.equal(q.active, 1); // wrapped, held until drained
  await ev.response.text();
  assert.equal(q.active, 0);
});

test("a queued-model event that resolves unqueued does not inherit the session selection", async () => {
  await handlers.httpRequest(req("testp", "fb2"));
  const q = queueOf("testp");
  assert.equal(q.active, 1);

  // Same session, but a model that has no queue: the direct lookup misses
  // and an event WITH a model must not fall back to fb2's session selection.
  const orig = new Response(closingStream());
  const ev = { kind: "primary", model: { providerID: "nqx", id: "y" }, sessionID: "fb2", response: orig };
  handlers.httpResponse(ev);
  assert.equal(ev.response, orig); // not wrapped
  assert.equal(q.active, 1); // slot untouched

  const t = openTicket(q); // cleanup: release fb2's still-held ticket
  if (t) release(q, t);
});

test("interrupting a queued request keeps the slot for live work", async () => {
  await handlers.httpRequest(req("t7p", "s1"));
  const q = queueOf("t7p");
  const p2 = handlers.httpRequest(req("t7p", "s2"));
  await flush();
  assert.equal(q.waiters.length, 1);

  // OpenCode interrupts a request that is still waiting for a slot: the
  // continuation is abandoned, so the waiter must be removed or it will
  // consume a slot that nothing will ever release (short of the lease).
  interruptSession("s2");
  await flush();
  assert.equal(q.waiters.length, 0);
  assert.equal(q.active, 1); // s1's live request is untouched

  release(q, openTicket(q)!); // s1 finishes
  await flush();
  assert.equal(q.active, 0); // the cancelled request did not grab the slot
  await p2;
});

test("interrupting a session releases a granted ticket with no response", async () => {
  await handlers.httpRequest(req("t8p", "s1"));
  const q = queueOf("t8p");
  assert.equal(q.active, 1);

  interruptSession("s1");
  assert.equal(q.active, 0);
  assert.equal(openTicket(q), undefined);
});

test("interrupting a session does not touch a running stream", async () => {
  await handlers.httpRequest(req("t9p", "s1"));
  const q = queueOf("t9p");
  const ev = { ...req("t9p", "s1"), response: new Response(new ReadableStream()) };
  handlers.httpResponse(ev);
  assert.equal(q.active, 1);

  interruptSession("s1");
  assert.equal(q.active, 1); // the body's cancel path owns this release

  await ev.response.body!.cancel();
  assert.equal(q.active, 0);
});

test("setup wires session.execution.interrupted to the queue", async () => {
  const hooked: Record<string, (event: never) => unknown> = {};
  const inbox: unknown[] = [];
  let signal: AbortSignal | undefined;
  const ctx = {
    location: { directory: locationDirectory },
    session: {
      hook: async (name: string, handler: (event: never) => unknown) => {
        hooked[name] = handler;
      },
    },
    event: {
      subscribe: (options: { signal?: AbortSignal } = {}) => {
        signal = options.signal;
        return {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              if (options.signal?.aborted) return;
              const next = inbox.shift();
              if (next === undefined) {
                await new Promise((r) => setTimeout(r, 5));
                continue;
              }
              yield next;
            }
          },
        };
      },
    },
  };
  const cleanup = await plugin.setup(ctx as never);
  try {
    const httpRequest = hooked["http.request"]!;
    await httpRequest(req("testp", "wire1") as never);
    const q = queueOf("testp");
    const queued = httpRequest(req("testp", "wire2") as never);
    await flush();
    assert.equal(q.waiters.length, 1);

    inbox.push({ type: "session.execution.interrupted", data: { sessionID: "wire2", reason: "user" } });
    const start = Date.now();
    while (q.waiters.length > 0 && Date.now() - start < 500) await new Promise((r) => setTimeout(r, 5));
    assert.equal(q.waiters.length, 0);
    assert.equal(q.active, 1);

    release(q, openTicket(q)!);
    await queued;
    assert.equal(q.active, 0);
  } finally {
    await cleanup?.();
  }
  assert.equal(signal?.aborted, true); // the subscription is torn down with the plugin
});

test("unqueued providers pass through", async () => {
  let done = false;
  await handlers.httpRequest(req("otherp", "s1")).then(() => (done = true));
  assert.equal(done, true);
  assert.equal(queues.has("otherp/*"), false);

  const ev = { ...req("otherp", "s1"), response: new Response(closingStream()) };
  handlers.httpResponse(ev); // no-op, must not throw
  handlers.retry({ ...req("otherp", "s1"), attempt: 1 }); // no-op
  assert.equal(queues.has("otherp/*"), false);
});

test("non-model kinds are ignored entirely", async () => {
  const ev = { kind: "other", model: model("t6p"), sessionID: "s1" };
  await handlers.httpRequest(ev);
  assert.equal(queues.has("t6p/*"), false);
  handlers.httpResponse({ ...ev, response: new Response("x") });
  assert.equal(queues.has("t6p/*"), false);
});
