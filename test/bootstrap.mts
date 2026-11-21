/**
 * Test bootstrap, loaded via `node --import` before any test file so it runs
 * in each test worker process BEFORE the plugin module is evaluated.
 *
 * src/index.ts resolves LOG_PATH from homedir() at module load and log()
 * appends unconditionally; without this redirect, `npm test` writes queue
 * activity into the real ~/.local/share/opencode/log/provider-queue.log and
 * pollutes the operational diagnostic humans read. Point HOME (and
 * USERPROFILE for the win32 fallback path) at an empty fixture directory:
 * log writes then fail into log()'s catch and go nowhere, and the global
 * config fallback reads the fixture instead of the developer's config.
 * Tests that need a global config still set XDG_CONFIG_HOME themselves.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pq-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
