/**
 * Queue lifecycle unit tests (Task 4, Step 1). Run with: npm test
 */
import assert from "node:assert/strict";
import test from "node:test";

import "./bootstrap.mts";
import { queueFor, acquire, release, openTicket, queues } from "../src/index.ts";

const flush = () => new Promise((r) => setImmediate(r));

test("FIFO: limit 1 blocks the second acquire until release", async () => {
  const q = queueFor("u-fifo1", 1);
  const t1 = await acquire(q);
  let secondDone = false;
  const p2 = acquire(q).then((t) => {
    secondDone = true;
    return t;
  });
  await flush();
  assert.equal(secondDone, false);
  assert.equal(q.active, 1);
  assert.equal(q.waiters.length, 1);

  release(q, t1);
  const t2 = await p2;
  assert.equal(secondDone, true);
  assert.equal(q.active, 1);
  release(q, t2);
  assert.equal(q.active, 0);
});

test("FIFO: three waiters resolve in queue order", async () => {
  const q = queueFor("u-fifo3", 1);
  const held = await acquire(q);
  const order: string[] = [];
  const ps = ["a", "b", "c"].map((name) =>
    acquire(q).then((t) => {
      order.push(name);
      return t;
    }),
  );
  await flush();
  assert.equal(q.waiters.length, 3);
  assert.deepEqual(order, []);

  release(q, held);
  const ta = await ps[0];
  release(q, ta);
  const tb = await ps[1];
  release(q, tb);
  const tc = await ps[2];
  release(q, tc); // every ticket released, or the armed lease timer keeps the test process alive
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("limit > 1: two concurrent holds allowed; release wakes exactly one", async () => {
  const q = queueFor("u-multi", 2);
  const t1 = await acquire(q);
  const t2 = await acquire(q);
  let third = false;
  const p3 = acquire(q).then((t) => {
    third = true;
    return t;
  });
  await flush();
  assert.equal(third, false);
  assert.equal(q.active, 2);

  release(q, t1);
  const t3 = await p3;
  assert.equal(third, true);
  assert.equal(q.active, 2); // t1 freed, t3 granted
  release(q, t2);
  release(q, t3);
  assert.equal(q.active, 0);
});

test("double release on the same ticket is a no-op", async () => {
  const q = queueFor("u-double", 2);
  const t1 = await acquire(q);
  const t2 = await acquire(q); // two live holders: a guardless second release would drop the count
  release(q, t1);
  release(q, t1); // no-op: the done guard
  assert.equal(q.active, 1);
  assert.equal(q.held.length, 1);
  assert.equal(q.held[0], t2);
  release(q, t2);
  assert.equal(q.active, 0);
});

test("limit change takes effect as slots free (raise, then lower)", async () => {
  const q = queueFor("u-limit", 1);
  const t1 = await acquire(q);
  const p2 = acquire(q);
  await flush();

  // Raised to 2: the pending waiter is NOT auto-granted.
  queueFor("u-limit", 2);
  assert.equal(q.limit, 2);
  let grantedEarly = false;
  void p2.then(() => (grantedEarly = true));
  await flush();
  assert.equal(grantedEarly, false);

  // A slot frees and wakes the waiter.
  release(q, t1);
  const t2 = await p2;
  assert.equal(grantedEarly, true);
  assert.equal(q.active, 1);

  // With the raised limit, a fresh request fits without waiting.
  const t3 = await Promise.race([acquire(q), flush().then(() => "pending" as const)]);
  assert.notEqual(t3, "pending");
  assert.equal(q.active, 2);

  // Lowered back to 1: new requests wait, but a freed slot is still handed
  // to the oldest waiter even while active momentarily exceeds the limit
  // (the template's documented "takes effect as slots free up").
  queueFor("u-limit", 1);
  let pending4 = true;
  const p4 = acquire(q).then((t) => {
    pending4 = false;
    return t;
  });
  await flush();
  assert.equal(pending4, true);
  release(q, t2);
  const t4 = await p4;
  assert.equal(q.active, 2);
  release(q, t3);
  release(q, t4);
  assert.equal(q.active, 0);
});

test("watchdog: expired lease force-releases a stuck slot", async () => {
  const q = queueFor("u-watchdog", 1);
  const stuck = await acquire(q, 20);
  const p2 = acquire(q);
  await new Promise((r) => setTimeout(r, 60));
  const t2 = await p2; // resolved via force-release of the expired ticket
  assert.equal(stuck.done, true);
  assert.equal(q.active, 1); // stuck released, t2 holds
  release(q, t2);
  assert.equal(q.active, 0);
  assert.equal(openTicket(q), undefined);
});

test("release hands the slot to the next waiter synchronously and keeps held exact", async () => {
  const q = queueFor("u-held", 1);
  const t1 = await acquire(q);
  const p2 = acquire(q);
  await flush();
  assert.equal(q.held.length, 1); // only t1 is materialized
  release(q, t1); // grant runs synchronously inside release
  const t2 = await p2;
  assert.equal(q.held.length, 1);
  assert.equal(q.held[0], t2);
  assert.equal(queues.get("u-held")?.held[0], t2);
  release(q, t2);
  assert.equal(q.held.length, 0);
  assert.equal(q.active, 0);
});
