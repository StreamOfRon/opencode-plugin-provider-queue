/**
 * Characterization tests for the config side of the port (Task 3).
 * Run with: npm test
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import "./bootstrap.mts";
import {
  parseJsonc,
  parseConcurrency,
  mergeLimits,
  configFilesFor,
  limitsFor,
  selectQueue,
} from "../src/index.ts";

// ---- parseJsonc ---------------------------------------------------------------

test("parseJsonc parses plain JSON", () => {
  assert.deepEqual(parseJsonc('{"a": 1, "b": {"c": [1, 2]}}'), { a: 1, b: { c: [1, 2] } });
});

test("parseJsonc strips line comments", () => {
  const doc = parseJsonc('{\n // hello\n "a": 1 // trailing\n}\n');
  assert.deepEqual(doc, { a: 1 });
});

test("parseJsonc strips block comments", () => {
  assert.deepEqual(parseJsonc('/* lead */ {"a": /* mid */ 1} /* tail */'), { a: 1 });
});

test("parseJsonc drops trailing commas", () => {
  assert.deepEqual(parseJsonc('{"a": [1, 2,], "b": {"c": 3,},}'), { a: [1, 2], b: { c: 3 } });
});

test("parseJsonc keeps comment-like text inside strings", () => {
  // trailing comma forces the lenient path, where string handling matters
  assert.deepEqual(parseJsonc('{"url": "http://x//y", "note": "/* not a comment */",}'), {
    url: "http://x//y",
    note: "/* not a comment */",
  });
});

test("parseJsonc keeps escaped quotes inside strings", () => {
  assert.deepEqual(parseJsonc('{"s": "he said \\"hi\\" // in string",}'), {
    s: 'he said "hi" // in string',
  });
});

test("parseJsonc throws on garbage", () => {
  assert.throws(() => parseJsonc("this is not json {{{"));
});

// ---- configFilesFor -----------------------------------------------------------

function withXdg<T>(fn: (xdg: string) => T): T {
  const xdg = mkdtempSync(join(tmpdir(), "pq-xdg-"));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    return fn(xdg);
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    rmSync(xdg, { recursive: true, force: true });
  }
}

test("configFilesFor orders global, direct far->near, .opencode far->near, system", () => {
  withXdg((xdg) => {
    const projRoot = mkdtempSync(join(tmpdir(), "pq-proj-"));
    const ancestor = join(projRoot, "parent");
    const project = join(ancestor, "child");
    mkdirSync(project, { recursive: true });
    try {
      const files = configFilesFor(project);
      const globalJson = join(xdg, "opencode", "opencode.json");
      const directProject = join(project, "opencode.json");
      const directAncestor = join(ancestor, "opencode.json");
      const dotProject = join(project, ".opencode", "opencode.json");
      const dotAncestor = join(ancestor, ".opencode", "opencode.json");

      // global first (json then jsonc)
      assert.equal(files[0], globalJson);
      // system last
      assert.match(files[files.length - 1], /^(\/Library\/Application Support|\/etc|C:\\ProgramData)/);
      assert.ok(files[files.length - 2].includes(join("opencode", "opencode.json")));

      const idx = (f: string) => files.indexOf(f);
      // direct configs: ancestors before descendants (merge is farthest-first)
      assert.ok(idx(directAncestor) < idx(directProject));
      // every direct config before every .opencode config
      assert.ok(idx(directProject) < idx(dotAncestor));
      // .opencode configs also far->near
      assert.ok(idx(dotAncestor) < idx(dotProject));
    } finally {
      rmSync(projRoot, { recursive: true, force: true });
    }
  });
});

// ---- parseConcurrency ---------------------------------------------------------

test("parseConcurrency maps valid, clearing, and invalid values", () => {
  assert.equal(parseConcurrency(1), 1);
  assert.equal(parseConcurrency("2"), 2);
  assert.equal(parseConcurrency(2.7), 2);
  assert.equal(parseConcurrency(null), null);
  assert.equal(parseConcurrency(0), undefined);
  assert.equal(parseConcurrency("abc"), undefined);
  assert.equal(parseConcurrency(undefined), undefined);
});

// ---- mergeLimits --------------------------------------------------------------

test("mergeLimits: provider stanza and model override", () => {
  const limits = mergeLimits([
    { providers: { p: { settings: { concurrency: 2 }, models: { m: { settings: { concurrency: 1 } } } } } },
  ]);
  assert.equal(limits.providers.get("p"), 2);
  assert.equal(limits.models.get("p/m"), 1);
});

test("mergeLimits: later docs win, precedence ascending", () => {
  const limits = mergeLimits([
    { providers: { p: { settings: { concurrency: 3 } } } },
    { providers: { p: { settings: { concurrency: 1 } } } },
  ]);
  assert.equal(limits.providers.get("p"), 1);
});

test("invalid concurrency values are ignored, null clears", () => {
  const base = { providers: { p: { settings: { concurrency: 2 }, models: { m: { settings: { concurrency: 1 } } } } } };

  // null in a later doc clears both provider and model entries
  const cleared = mergeLimits([base, { providers: { p: { settings: { concurrency: null }, models: { m: { settings: { concurrency: null } } } } } }]);
  assert.equal(cleared.providers.has("p"), false);
  assert.equal(cleared.models.has("p/m"), false);

  // invalid values leave the earlier entry intact
  const intact = mergeLimits([base, { providers: { p: { settings: { concurrency: 0 }, models: { m: { settings: { concurrency: "abc" } } } } } }]);
  assert.equal(intact.providers.get("p"), 2);
  assert.equal(intact.models.get("p/m"), 1);
});

// ---- limitsFor / unparseable files --------------------------------------------

test("unparseable config files are skipped", () => {
  withXdg((xdg) => {
    const cfgDir = join(xdg, "opencode");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "opencode.json"), "!!corrupt{{{");
    writeFileSync(
      join(cfgDir, "opencode.jsonc"),
      '{ "providers": { "goodp": { "settings": { "concurrency": 1 } } } }',
    );
    const project = mkdtempSync(join(tmpdir(), "pq-proj-"));
    const logPath = join(process.env.HOME!, ".local", "share", "opencode", "log", "provider-queue.log");
    const readLog = () => {
      try {
        return readFileSync(logPath, "utf8");
      } catch {
        return ""; // the file is created on the plugin's first log write
      }
    };
    const before = readLog();
    try {
      const limits = limitsFor(project); // must not throw
      assert.equal(limits.providers.get("goodp"), 1);
      const appended = readLog().slice(before.length);
      assert.match(appended, new RegExp(`skipping ${escapeRe(join(cfgDir, "opencode.json"))}`));
      assert.doesNotMatch(appended, /opencode\.jsonc/); // the valid sibling is not logged as skipped
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- selectQueue ---------------------------------------------------------------

test("selectQueue: model beats provider, key shapes, missing model unqueued", () => {
  const limits = mergeLimits([
    { providers: { p: { settings: { concurrency: 4 }, models: { m: { settings: { concurrency: 1 } } } } } },
  ]);
  assert.deepEqual(selectQueue(limits, { providerID: "p", id: "m" }), { key: "p/m", limit: 1 });
  assert.deepEqual(selectQueue(limits, { providerID: "p", id: "other" }), { key: "p/*", limit: 4 });
  assert.equal(selectQueue(limits, undefined), undefined);
  assert.equal(selectQueue(limits, { providerID: "z", id: "m" }), undefined);
  assert.equal(selectQueue(limits, { providerID: "", id: "m" }), undefined);
});
