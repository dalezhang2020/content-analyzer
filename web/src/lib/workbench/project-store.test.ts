import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFile, readdir, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import fc from "fast-check";

import {
  createProject,
  deleteProject,
  generateProjectId,
  listProjects,
  readProject,
  writeProject,
} from "@/lib/workbench/project-store";
import { ErrorCode, isWorkbenchError } from "@/lib/workbench/errors";
import { useTmpDir } from "@/test/fixtures/tmp-dir";
import { DATA_DIR } from "@/lib/workbench/constants";
import type {
  CreateProjectInput,
  Project,
  TemplateSource,
} from "@/lib/workbench/types";

// Feature: video-creation-workbench — T20.2
// Integration tests for the filesystem-backed Project store. Each test gets
// a fresh tmp-dir sandbox via `useTmpDir()` and `process.chdir` so the
// store's `getDataDirAbs()` resolves under the sandbox.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestInput(
  overrides?: Partial<CreateProjectInput>,
): CreateProjectInput {
  return {
    title: "Test",
    topic: "A video about testing",
    locale: "zh-CN",
    ...overrides,
  };
}

function fakeTemplateSource(): TemplateSource {
  return {
    name: "linear-launch",
    version: "0.0.0-test",
    sourcePath: "/irrelevant",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Per-test fixture wiring
// ---------------------------------------------------------------------------

describe("project-store integration", () => {
  const getTmp = useTmpDir("workbench-project-store-");
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
  // 1. generateProjectId shape
  // -------------------------------------------------------------------------
  it("generateProjectId returns a value matching the spec regex", async () => {
    const id = await generateProjectId();
    expect(id).toMatch(/^proj_\d+_[a-z0-9]{6}$/);
  });

  // -------------------------------------------------------------------------
  // 2. createProject + readProject round-trip
  // -------------------------------------------------------------------------
  it("createProject + readProject returns a fully populated Project", async () => {
    const created = await createProject(createTestInput(), fakeTemplateSource());
    const readBack = await readProject(created.projectId);

    expect(readBack.projectId).toBe(created.projectId);
    expect(readBack.title).toBe("Test");
    expect(readBack.topic).toBe("A video about testing");
    expect(readBack.locale).toBe("zh-CN");
    expect(readBack.schemaVersion).toBe(1);
    expect(readBack.stage).toBe("topic");
    expect(readBack.stageHistory).toEqual([]);
    expect(readBack.brief).toBeNull();
    expect(readBack.storyboard).toBeNull();
    expect(readBack.qaNotes).toEqual([]);
    expect(readBack.templateSource).toEqual(fakeTemplateSource());

    // Every stage status starts "pending"
    for (const stage of [
      "topic",
      "brief",
      "storyboard",
      "composition",
      "audio",
      "render",
      "qa",
      "published",
    ] as const) {
      expect(readBack.stageStatus[stage]).toEqual({ status: "pending" });
    }

    // ISO timestamps round-trip
    expect(() => new Date(readBack.createdAt).toISOString()).not.toThrow();
    expect(() => new Date(readBack.updatedAt).toISOString()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // 3. createProject writes the directory tree
  // -------------------------------------------------------------------------
  it("createProject scaffolds composition/assets/.gitkeep, composition/fonts/.gitkeep, logs/", async () => {
    const created = await createProject(createTestInput(), fakeTemplateSource());
    const tmp = await getTmp();
    const projectDir = path.join(tmp.path, DATA_DIR, created.projectId);

    const compositionDir = path.join(projectDir, "composition");
    const assetsDir = path.join(compositionDir, "assets");
    const fontsDir = path.join(compositionDir, "fonts");
    const logsDir = path.join(projectDir, "logs");
    const assetsGitkeep = path.join(assetsDir, ".gitkeep");
    const fontsGitkeep = path.join(fontsDir, ".gitkeep");

    expect((await stat(compositionDir)).isDirectory()).toBe(true);
    expect((await stat(assetsDir)).isDirectory()).toBe(true);
    expect((await stat(fontsDir)).isDirectory()).toBe(true);
    expect((await stat(logsDir)).isDirectory()).toBe(true);
    expect((await stat(assetsGitkeep)).isFile()).toBe(true);
    expect((await stat(fontsGitkeep)).isFile()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. writeProject + readProject round-trip, updatedAt strictly advances
  // -------------------------------------------------------------------------
  it("writeProject updates content and advances updatedAt", async () => {
    const created = await createProject(createTestInput(), fakeTemplateSource());
    const p1 = await readProject(created.projectId);

    // Ensure the wall-clock advances so updatedAt is strictly greater.
    await sleep(15);

    const modified: Project = { ...p1, title: "Renamed" };
    await writeProject(modified);

    const p2 = await readProject(created.projectId);
    expect(p2.title).toBe("Renamed");
    // Everything else apart from title + updatedAt is preserved.
    expect(p2.projectId).toBe(p1.projectId);
    expect(p2.topic).toBe(p1.topic);
    expect(p2.locale).toBe(p1.locale);
    expect(p2.schemaVersion).toBe(p1.schemaVersion);
    expect(p2.stage).toBe(p1.stage);
    expect(p2.createdAt).toBe(p1.createdAt);

    // Strict monotonicity.
    expect(p2.updatedAt > p1.updatedAt).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. writeProject rejects a malformed in-memory Project
  // -------------------------------------------------------------------------
  it("writeProject throws WRITE_FAILED with zod issues when the Project is malformed", async () => {
    const created = await createProject(createTestInput(), fakeTemplateSource());
    const p1 = await readProject(created.projectId);

    // Force an invalid Project value to exercise the pre-write validation.
    const bad = { ...p1, stage: "invalid" } as unknown as Project;

    try {
      await writeProject(bad);
      throw new Error("expected writeProject to throw");
    } catch (e) {
      expect(isWorkbenchError(e)).toBe(true);
      if (!isWorkbenchError(e)) throw e;
      expect(e.code).toBe(ErrorCode.WRITE_FAILED);
      expect(Array.isArray(e.details?.issues)).toBe(true);
      expect((e.details?.issues as unknown[]).length).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // 6. readProject maps ENOENT to PROJECT_NOT_FOUND
  // -------------------------------------------------------------------------
  it("readProject throws PROJECT_NOT_FOUND when the file is missing", async () => {
    // A well-formed projectId that does not exist on disk.
    const missingId = "proj_1700000000000_abcdef";

    try {
      await readProject(missingId);
      throw new Error("expected readProject to throw");
    } catch (e) {
      expect(isWorkbenchError(e)).toBe(true);
      if (!isWorkbenchError(e)) throw e;
      expect(e.code).toBe(ErrorCode.PROJECT_NOT_FOUND);
      expect(e.details?.projectId).toBe(missingId);
    }
  });

  // -------------------------------------------------------------------------
  // 7. readProject rejects a projectId that fails the regex
  // -------------------------------------------------------------------------
  it("readProject throws INVALID_PROJECT_ID when the id fails the regex", async () => {
    try {
      await readProject("not-a-valid-id");
      throw new Error("expected readProject to throw");
    } catch (e) {
      expect(isWorkbenchError(e)).toBe(true);
      if (!isWorkbenchError(e)) throw e;
      expect(e.code).toBe(ErrorCode.INVALID_PROJECT_ID);
    }
  });

  // -------------------------------------------------------------------------
  // 8. readProject surfaces SCHEMA_VERSION_MISMATCH
  // -------------------------------------------------------------------------
  it("readProject throws SCHEMA_VERSION_MISMATCH when schemaVersion is wrong", async () => {
    const created = await createProject(createTestInput(), fakeTemplateSource());
    const tmp = await getTmp();
    const jsonPath = path.join(
      tmp.path,
      DATA_DIR,
      `${created.projectId}.json`,
    );

    // Directly overwrite the on-disk JSON with schemaVersion=999.
    const bogus = {
      schemaVersion: 999,
      projectId: created.projectId,
      title: "whatever",
    };
    await writeFile(jsonPath, JSON.stringify(bogus), "utf8");

    try {
      await readProject(created.projectId);
      throw new Error("expected readProject to throw");
    } catch (e) {
      expect(isWorkbenchError(e)).toBe(true);
      if (!isWorkbenchError(e)) throw e;
      expect(e.code).toBe(ErrorCode.SCHEMA_VERSION_MISMATCH);
      expect(e.details?.found).toBe(999);
      expect(e.details?.expected).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // 9. readProject surfaces READ_FAILED on corrupt JSON
  // -------------------------------------------------------------------------
  it("readProject throws READ_FAILED with a parse-reason when JSON is corrupt", async () => {
    const created = await createProject(createTestInput(), fakeTemplateSource());
    const tmp = await getTmp();
    const jsonPath = path.join(
      tmp.path,
      DATA_DIR,
      `${created.projectId}.json`,
    );

    await writeFile(jsonPath, "{ not json", "utf8");

    try {
      await readProject(created.projectId);
      throw new Error("expected readProject to throw");
    } catch (e) {
      expect(isWorkbenchError(e)).toBe(true);
      if (!isWorkbenchError(e)) throw e;
      expect(e.code).toBe(ErrorCode.READ_FAILED);
      // The message itself identifies the failure mode as an invalid JSON parse.
      expect(e.message).toBe("Invalid JSON");
      expect(typeof e.details?.reason).toBe("string");
      // Path comparison is symlink-agnostic (macOS tmpdir resolves via /private).
      expect(typeof e.details?.path).toBe("string");
      expect((e.details?.path as string).endsWith(`${created.projectId}.json`)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // 10. deleteProject returns a DeleteReport with non-empty succeeded, no failures
  // -------------------------------------------------------------------------
  it("deleteProject removes the project and subsequent reads 404", async () => {
    const created = await createProject(createTestInput(), fakeTemplateSource());

    const report = await deleteProject(created.projectId);
    expect(report.failed).toEqual([]);
    expect(report.succeeded.length).toBeGreaterThan(0);
    // Every reported path should be a non-empty string.
    for (const p of report.succeeded) {
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(0);
    }

    try {
      await readProject(created.projectId);
      throw new Error("expected readProject to throw after delete");
    } catch (e) {
      expect(isWorkbenchError(e)).toBe(true);
      if (!isWorkbenchError(e)) throw e;
      expect(e.code).toBe(ErrorCode.PROJECT_NOT_FOUND);
    }

    // No `{id}.json` left under data/projects.
    const tmp = await getTmp();
    const dataDir = path.join(tmp.path, DATA_DIR);
    // dataDir may or may not exist; either way, it should not contain the deleted id.
    try {
      const entries = await readdir(dataDir);
      expect(entries).not.toContain(`${created.projectId}.json`);
      expect(entries).not.toContain(created.projectId);
    } catch (e) {
      // readdir on missing dir is acceptable — nothing to assert further.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  });

  // -------------------------------------------------------------------------
  // 11. listProjects returns newest-first order
  // -------------------------------------------------------------------------
  it("listProjects returns projects sorted by updatedAt descending", async () => {
    const a = await createProject(
      createTestInput({ title: "A" }),
      fakeTemplateSource(),
    );
    // Ensure the wall-clock advances so B's updatedAt > A's.
    await sleep(15);
    const b = await createProject(
      createTestInput({ title: "B" }),
      fakeTemplateSource(),
    );

    const list = await listProjects();
    expect(list).toHaveLength(2);

    const [first, second] = list;
    expect(first.projectId).toBe(b.projectId);
    expect(first.title).toBe("B");
    expect(second.projectId).toBe(a.projectId);
    expect(second.title).toBe("A");

    // Ensure updatedAt ordering is actually descending.
    expect(first.updatedAt >= second.updatedAt).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Edge: listProjects on empty workspace
  // -------------------------------------------------------------------------
  it("listProjects returns [] when no projects exist", async () => {
    const tmp = await getTmp();
    // Ensure data dir is absent so we hit the ensureDir-then-empty-readdir path.
    await mkdir(path.join(tmp.path, "data"), { recursive: true });
    const list = await listProjects();
    expect(list).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Property tests (fast-check)
  // -------------------------------------------------------------------------
  describe("property tests", () => {
    // -----------------------------------------------------------------------
    // T20.3 — Property 6: updatedAt is monotonic across any mutation sequence
    // -----------------------------------------------------------------------
    // For any non-empty sequence of store mutations m₁…mₙ applied via
    // writeProject, every persisted `updatedAt` satisfies
    // `updatedAt_i >= updatedAt_{i-1}`. ISO 8601 strings compare
    // lexicographically in time order, so plain `>=` on the string is
    // equivalent to `new Date(...) >=` on the parsed Date.
    //
    // **Validates: Requirements 2.5**
    it("Property 6: writeProject never regresses updatedAt across arbitrary mutation sequences", async () => {
      // Arbitrary single-mutation command. Each command returns a *next*
      // Project from a *previous* Project — keeping the mutation set
      // schema-valid.
      const mutationArb = fc.oneof(
        fc
          .string({ minLength: 1, maxLength: 50 })
          .filter((s) => !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(s))
          .map((title) => (p: Project): Project => ({ ...p, title })),
        fc
          .string({ minLength: 1, maxLength: 100 })
          .filter((s) => !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(s))
          .map((topic) => (p: Project): Project => ({ ...p, topic })),
        fc
          .constantFrom<"zh-CN" | "en-US">("zh-CN", "en-US")
          .map((locale) => (p: Project): Project => ({ ...p, locale })),
        // A no-op mutation — should still bump updatedAt (or at worst keep
        // it equal within the same ms; never regress).
        fc.constant((p: Project): Project => ({ ...p })),
      );

      await fc.assert(
        fc.asyncProperty(
          fc.array(mutationArb, { minLength: 1, maxLength: 8 }),
          async (mutations) => {
            const base = await createProject(
              createTestInput(),
              fakeTemplateSource(),
            );
            let current = await readProject(base.projectId);
            let prevUpdatedAt = current.updatedAt;

            for (const apply of mutations) {
              // Advance the wall-clock by 2 ms so updatedAt has room to
              // move forward — the property we're checking is
              // non-decreasing, which must hold even without a sleep, but
              // the sleep makes the strict case exercisable as well.
              await sleep(2);
              const next = apply(current);
              await writeProject(next);

              const reread = await readProject(base.projectId);
              // Non-decreasing: parsed-Date comparison matches ISO string
              // compare, so assert on both for defence-in-depth.
              expect(reread.updatedAt >= prevUpdatedAt).toBe(true);
              expect(
                new Date(reread.updatedAt).getTime() >=
                  new Date(prevUpdatedAt).getTime(),
              ).toBe(true);

              prevUpdatedAt = reread.updatedAt;
              current = reread;
            }

            // Clean up between iterations — createProject allocates a
            // fresh ID every time, but the tmp-dir is shared across the
            // 100 property runs (useTmpDir is per-it not per-run).
            await deleteProject(base.projectId);
          },
        ),
        // Keep this below the default 100 runs so the integration-style
        // test doesn't dominate the suite.
        { numRuns: 25 },
      );
    });

    // -----------------------------------------------------------------------
    // T20.4 — Property 8: Malformed project JSON is rejected, never silently
    //                     repaired.
    // -----------------------------------------------------------------------
    // For any byte string that is not a valid UTF-8 JSON matching
    // ProjectSchema, readProject throws a typed WorkbenchError containing
    // the file path; it never returns an empty or partially-populated
    // project, and never rewrites the file on disk.
    //
    // Classification:
    //   - invalid JSON syntax (random bytes, truncated)     → READ_FAILED
    //   - valid JSON but schemaVersion missing/wrong        → SCHEMA_VERSION_MISMATCH
    //   - valid JSON + schemaVersion=1 but missing fields   → READ_FAILED with issues
    //
    // **Validates: Requirements 2.9, 2.10**
    it("Property 8: readProject rejects malformed JSON with typed errors, never silently repairs", async () => {
      // Four independent generators, each tagged so the property can
      // assert the correct error taxonomy for that shape.
      type Case =
        | { kind: "bytes"; bytes: string; expected: ErrorCode.READ_FAILED }
        | {
            kind: "truncated";
            bytes: string;
            expected: ErrorCode.READ_FAILED;
          }
        | {
            kind: "versionMismatch";
            bytes: string;
            expected: ErrorCode.SCHEMA_VERSION_MISMATCH;
          }
        | {
            kind: "missingFields";
            bytes: string;
            expected: ErrorCode.READ_FAILED;
          };

      // Random-bytes / random-string generator. Filter out the (vanishingly
      // rare) cases where the string happens to be valid JSON that also
      // shapes up as a Project — fast-check's unicodeString shrinker can
      // stumble onto `{}` for example, which is handled by the
      // missingFields branch instead.
      const bytesCase: fc.Arbitrary<Case> = fc
        .string({ minLength: 0, maxLength: 200 })
        .filter((s) => {
          try {
            JSON.parse(s);
            return false; // valid JSON — routed to other branches
          } catch {
            return true;
          }
        })
        .map((bytes) => ({
          kind: "bytes" as const,
          bytes,
          expected: ErrorCode.READ_FAILED as const,
        }));

      // A well-formed-ish JSON prefix that is then truncated mid-structure
      // so JSON.parse fails at a deterministic position.
      const truncatedCase: fc.Arbitrary<Case> = fc
        .integer({ min: 1, max: 40 })
        .map((cut) => {
          const full = JSON.stringify({
            schemaVersion: 1,
            projectId: "proj_1700000000000_abcdef",
            title: "x",
          });
          return {
            kind: "truncated" as const,
            bytes: full.slice(0, cut),
            expected: ErrorCode.READ_FAILED as const,
          };
        });

      // Valid JSON but with schemaVersion drawn from the "anything except 1"
      // space. The store's schemaVersion gate runs before zod parsing so
      // only the discriminator matters here.
      const versionMismatchCase: fc.Arbitrary<Case> = fc
        .oneof(
          fc.integer().filter((n) => n !== 1),
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.constantFrom(null, undefined, true, false, 0, 2, 999, -1, 1.5),
        )
        .map((badVersion) => ({
          kind: "versionMismatch" as const,
          bytes: JSON.stringify({
            schemaVersion: badVersion,
            projectId: "proj_1700000000000_abcdef",
            title: "irrelevant",
          }),
          expected: ErrorCode.SCHEMA_VERSION_MISMATCH as const,
        }));

      // schemaVersion === 1 but required fields are missing, so zod fails.
      const missingFieldsCase: fc.Arbitrary<Case> = fc
        .record({
          drop: fc.subarray([
            "projectId",
            "title",
            "topic",
            "locale",
            "stage",
            "stageStatus",
            "artifacts",
            "templateSource",
            "createdAt",
            "updatedAt",
          ]),
        })
        .map(({ drop }) => {
          const skeleton: Record<string, unknown> = {
            schemaVersion: 1,
            projectId: "proj_1700000000000_abcdef",
            title: "x",
            topic: "x",
            locale: "zh-CN",
            stage: "topic",
            // Fields below are intentionally incomplete — zod will reject
            // whichever keys are missing.
          };
          for (const key of drop) delete skeleton[key];
          // Also delete at least one key that's not in the skeleton so
          // zod definitely complains (artifacts, stageStatus, etc.).
          return {
            kind: "missingFields" as const,
            bytes: JSON.stringify(skeleton),
            expected: ErrorCode.READ_FAILED as const,
          };
        });

      const caseArb: fc.Arbitrary<Case> = fc.oneof(
        bytesCase,
        truncatedCase,
        versionMismatchCase,
        missingFieldsCase,
      );

      await fc.assert(
        fc.asyncProperty(caseArb, async (c) => {
          // Write the malformed payload directly to
          // data/projects/{id}.json, bypassing the store entirely.
          const projectId = await generateProjectId();
          const tmp = await getTmp();
          const dataDirAbs = path.join(tmp.path, DATA_DIR);
          await mkdir(dataDirAbs, { recursive: true });
          const jsonPath = path.join(dataDirAbs, `${projectId}.json`);
          await writeFile(jsonPath, c.bytes, "utf8");

          // Snapshot the on-disk bytes so we can prove readProject did NOT
          // silently repair the file.
          const beforeStat = await stat(jsonPath);

          let caught: unknown;
          try {
            await readProject(projectId);
          } catch (e) {
            caught = e;
          }

          // Must throw, must be a WorkbenchError, must carry the expected
          // code.
          expect(caught).toBeDefined();
          expect(isWorkbenchError(caught)).toBe(true);
          if (!isWorkbenchError(caught)) throw caught;
          expect(caught.code).toBe(c.expected);
          // Every rejection path includes the file path in details so the
          // caller can log which file was bad.
          expect(typeof caught.details?.path).toBe("string");
          expect(
            (caught.details?.path as string).endsWith(`${projectId}.json`),
          ).toBe(true);

          // File on disk is untouched — same size, same mtime bucket.
          const afterStat = await stat(jsonPath);
          expect(afterStat.size).toBe(beforeStat.size);
          expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
        }),
        { numRuns: 40 },
      );
    });
  });
});
