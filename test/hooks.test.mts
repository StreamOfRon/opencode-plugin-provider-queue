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
import { buildHandlers, queues, openTicket, release } from "../src/index.ts";

// Config fixture: every queued provider at concurrency 1; `otherp` absent.
const xdg = mkdtempSync(join(tmpdir(), "pq-hooks-xdg-"));
mkdirSync(join(xdg, "opencode"), { recursive: true });
const providers: Record<string, unknown> = { testp: { settings: { concurrency: 1 } } };
for (const p of ["t1p", "t2p", "t3p", "t4p", "t5p", "t6p"]) providers[p] = { settings: { concurrency: 1 } };
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
