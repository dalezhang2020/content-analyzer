/**
 * Video Creation Workbench — logger property tests (T13.2).
 *
 * Property 25: Log rotation bounds file count and size.
 *   _Validates: Requirements 14.3_
 *
 * For any sequence of writes that exceed the rotation threshold, after the
 * logger has settled there are at most 4 log files on disk for the given
 * `(projectId, stage)` pair:
 *   - `{stage}.log`       (live file)
 *   - `{stage}.log.1` / `.log.2` / `.log.3`  (rotated history)
 *
 * `{stage}.log.4+` must NEVER exist, no matter how many writes happen.
 *
 * Supplementary property (same file, same module): the redaction pass
 * masks string values that equal (or contain) an environment-variable
 * value of length ≥ 16 as `***REDACTED***` before the line is written.
 *
 * To keep the test fast we monkey-patch `@/lib/workbench/constants` to
 * shrink `LOG_FILE_MAX_BYTES` from 10 MB to 256 bytes — the rotation
 * logic under test keys off this constant, so the bound check is
 * semantically identical. `numRuns` is capped at 5 per the property-test
 * guidelines for I/O-heavy properties.
 */

import fc from "fast-check";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Hoisted state — must be declared through `vi.hoisted` so the `vi.mock`
// factory below (which is itself hoisted above all imports) can read it
// and so the env-var is present BEFORE logger.ts snapshots SECRET_VALUES.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  // A dummy "secret" that is:
  //   - exactly 28 chars (>= 16, so the redactor picks it up)
  //   - unique enough not to appear incidentally in log envelope fields
  const TEST_SECRET = "wb-logger-test-secret-xyz789";

  // Seed the env BEFORE any module import so logger.ts's `SECRET_VALUES`
  // snapshot (built at module load) contains this value.
  process.env.WORKBENCH_TEST_SECRET = TEST_SECRET;

  return {
    TEST_SECRET,
    // Tiny rotation threshold so a handful of short writes trigger
    // multiple rotations — keeps the property test fast while still
    // exercising the exact same code path as the 10 MB production value.
    LOG_FILE_MAX_BYTES: 256,
    LOG_HISTORY_MAX: 3,
  };
});

// Override only the two rotation-related fields on `LIMITS`; everything
// else (REGEX, STAGE_DIRS, DATA_DIR) must continue to match production.
vi.mock("@/lib/workbench/constants", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/workbench/constants")>();
  return {
    ...actual,
    LIMITS: {
      ...actual.LIMITS,
      LOG_FILE_MAX_BYTES: hoisted.LOG_FILE_MAX_BYTES,
      LOG_HISTORY_MAX: hoisted.LOG_HISTORY_MAX,
    },
  };
});

// These imports MUST come after the `vi.mock` + `vi.hoisted` block above
// so the mocked constants are what logger.ts sees.
import { createLogger } from "@/lib/workbench/logger";
import { DATA_DIR, STAGE_DIRS } from "@/lib/workbench/constants";
import { useTmpDir } from "@/test/fixtures/tmp-dir";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_PROJECT_ID = "proj_1700000000000_abc123";
const STAGE = "brief" as const;

/** Absolute path to the logs directory for VALID_PROJECT_ID under cwd. */
function logsDirAbs(): string {
  return path.resolve(process.cwd(), DATA_DIR, VALID_PROJECT_ID, STAGE_DIRS.LOGS);
}

/** Absolute path to the live `{stage}.log` file. */
function liveLogAbs(): string {
  return path.join(logsDirAbs(), `${STAGE}.log`);
}

/**
 * List every entry in the logs directory (after any writes) whose name
 * begins with `{stage}.log` — including rotated history files.
 */
async function listLogFiles(): Promise<string[]> {
  try {
    const entries = await readdir(logsDirAbs());
    return entries
      .filter((n) => n === `${STAGE}.log` || n.startsWith(`${STAGE}.log.`))
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Test fixture — each property run gets its own tmp cwd so files cannot
// leak between runs of the same property.
// ---------------------------------------------------------------------------

describe("logger — Property 25 (rotation bounds)", () => {
  const getTmp = useTmpDir("workbench-logger-");
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    const tmp = await getTmp();
    process.chdir(tmp.path);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  // -------------------------------------------------------------------------
  // Property 25 — rotation bounds
  // _Validates: Requirements 14.3_
  // -------------------------------------------------------------------------
  it("keeps at most 4 files total and never creates `.log.4+` regardless of write volume", async () => {
    await fc.assert(
      fc.asyncProperty(
        // An array of 6..40 writes, each a "payload length" in bytes.
        // Keeping payloads within [50..300] and enough entries to force
        // several rotation cycles past the 256-byte threshold.
        fc.array(fc.integer({ min: 50, max: 300 }), {
          minLength: 6,
          maxLength: 40,
        }),
        async (payloadSizes) => {
          // Fresh per-run tmp dir: afterEach cleans the outer one between
          // top-level tests, but within a single property run we need a
          // fresh sandbox per iteration to isolate file-count assertions.
          const runTmp = await getTmp();
          process.chdir(runTmp.path);

          const logger = createLogger(VALID_PROJECT_ID, STAGE);

          // Sequentially await every write so the logger's internal
          // per-file queue drains before we inspect the filesystem. If we
          // fired-and-forgot them the assertion could race with pending
          // rotations.
          for (const size of payloadSizes) {
            await logger.info("rotation-probe", {
              // Pad string to roughly `size` bytes. Content itself is
              // irrelevant — we only care about byte accounting.
              payload: "x".repeat(size),
            });
          }

          const files = await listLogFiles();

          // Universal bound — the whole point of the property.
          expect(files.length).toBeLessThanOrEqual(1 + hoisted.LOG_HISTORY_MAX);

          // Every filename must match the allowed set: live log, or a
          // numeric suffix in [1..LOG_HISTORY_MAX]. Anything else (e.g.
          // `.log.4`) is a rotation-logic bug.
          const allowed = new Set<string>([
            `${STAGE}.log`,
            ...Array.from(
              { length: hoisted.LOG_HISTORY_MAX },
              (_, i) => `${STAGE}.log.${i + 1}`,
            ),
          ]);
          for (const name of files) {
            expect(allowed.has(name)).toBe(true);
          }

          // Spot-check: if the live file exists it must be non-empty
          // (the last `.info()` call was awaited).
          if (files.includes(`${STAGE}.log`)) {
            const s = await stat(liveLogAbs());
            expect(s.size).toBeGreaterThan(0);
          }
        },
      ),
      // I/O-heavy property — small run count is explicit per the task
      // brief (a few seconds total runtime).
      { numRuns: 5 },
    );
  });
});

// ---------------------------------------------------------------------------
// Redaction property — env-var values of length >= 16 are masked.
// ---------------------------------------------------------------------------

describe("logger — redaction of env-shaped secrets", () => {
  const getTmp = useTmpDir("workbench-logger-redact-");
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    const tmp = await getTmp();
    process.chdir(tmp.path);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("masks any string value equal to an env-var value of length >= 16", async () => {
    const logger = createLogger(VALID_PROJECT_ID, STAGE);

    await logger.info("secret-echo", {
      // Exact match — should become "***REDACTED***".
      bearerToken: hoisted.TEST_SECRET,
      // Embedded inside a larger string — still caught (substring match
      // per logger.ts `containsSecret`).
      header: `Authorization: Bearer ${hoisted.TEST_SECRET}`,
      // Safe short string — must pass through unchanged.
      safe: "plain text",
    });

    const raw = await readFile(liveLogAbs(), "utf8");
    // There is exactly one line.
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;

    expect(entry.bearerToken).toBe("***REDACTED***");
    expect(entry.header).toBe("***REDACTED***");
    expect(entry.safe).toBe("plain text");

    // Sanity check envelope fields the logger itself adds are also
    // present and unaffected (we don't want the redactor to clobber
    // them accidentally).
    expect(entry.level).toBe("info");
    expect(entry.stage).toBe(STAGE);
    expect(entry.event).toBe("secret-echo");
  });
});
