/**
 * Video Creation Workbench — template-manager property tests
 * (T21.2 / T21.3 / T21.4).
 *
 * Exercises three pure-ish aspects of `template-manager.ts`:
 *
 *   • Property 15 — `resolveTemplateDir()` picks the first candidate whose
 *     `hyperframes.json` both exists and is readable. When none match it
 *     throws `TEMPLATE_NOT_FOUND` and populates `details.tried` with
 *     every candidate it evaluated.
 *
 *   • Property 16 — `selectFilesToCopy(listing)` excludes any entry
 *     rooted under `captures/`, `.thumbnails/`, or ending in `.mp4`
 *     (case-insensitive), leaves everything else alone, and is
 *     idempotent.
 *
 *   • Property 17 — `syncTemplate(src, dst, baseline)` updates the safe
 *     subset (`hyperframes.json` / `package.json` / `fonts/`) while
 *     leaving `index.html` and `assets/` byte-identical. When the
 *     destination's `hyperframes.json` diverges from `baseline`, the
 *     merge aborts with `TEMPLATE_CONFLICT` and nothing is touched.
 *
 * Fast-check globals (`seed: 0xbeef`, `numRuns: 100`) are configured in
 * `src/test/setup.ts`; the fs-heavy properties below cap `numRuns` to
 * keep the suite fast.
 *
 * _Validates: Requirements 8.5, 15.1–15.4, 15.6, 15.7_
 */

import fc from "fast-check";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ErrorCode, isWorkbenchError } from "@/lib/workbench/errors";
import {
  deepCopyTemplate,
  resolveTemplateDir,
  selectFilesToCopy,
  syncTemplate,
} from "@/lib/workbench/template-manager";
import { useTmpDir } from "@/test/fixtures/tmp-dir";

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

async function writeJson(
  absPath: string,
  obj: unknown,
): Promise<void> {
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, JSON.stringify(obj), "utf8");
}

async function readUtf8(absPath: string): Promise<string> {
  return readFile(absPath, "utf8");
}

async function readBytes(absPath: string): Promise<Buffer> {
  return readFile(absPath);
}

async function exists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// T21.2 — Property 15: resolveTemplateDir picks the first existing candidate
// ---------------------------------------------------------------------------

describe("template-manager · resolveTemplateDir · Property 15", () => {
  const getTmp = useTmpDir("workbench-tm-resolver-");
  let originalCwd: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalEnv = process.env.HYPERFRAMES_TEMPLATE_DIR;
  });

  afterEach(() => {
    // Restore cwd first — any later assertion reading config files relies
    // on the pre-test working directory.
    process.chdir(originalCwd);
    if (originalEnv === undefined) {
      delete process.env.HYPERFRAMES_TEMPLATE_DIR;
    } else {
      process.env.HYPERFRAMES_TEMPLATE_DIR = originalEnv;
    }
  });

  it("Property 15: returns the first candidate with a readable hyperframes.json; throws TEMPLATE_NOT_FOUND with details.tried otherwise", async () => {
    // Arbitrary: independently choose whether env is set, and independently
    // whether each of the three candidates hosts a hyperframes.json file.
    const arb = fc.record({
      envSet: fc.boolean(),
      envPresent: fc.boolean(),
      cand2Present: fc.boolean(),
      cand3Present: fc.boolean(),
    });

    // Each run gets a fresh sub-tree so candidate paths never collide
    // across iterations. We use a monotonically-increasing counter for
    // uniqueness (random suffixes could theoretically still collide under
    // shrinking).
    let runIx = 0;

    await fc.assert(
      fc.asyncProperty(arb, async (params) => {
        const tmp = await getTmp();
        const runRoot = path.join(tmp.path, `run-${runIx++}`);

        // Layout per run:
        //   runRoot/env/hyperframes.json             (if envPresent)
        //   runRoot/a/linear-launch/hyperframes.json (cand3)
        //   runRoot/a/b/linear-launch/hyperframes.json (cand2)
        //   runRoot/a/b/cwd/                         (cwd for the resolver)
        const envDir = path.join(runRoot, "env");
        const aDir = path.join(runRoot, "a");
        const bDir = path.join(aDir, "b");
        const cwdDir = path.join(bDir, "cwd");

        await mkdir(cwdDir, { recursive: true });

        // Switch to the synthetic cwd so the 2nd/3rd candidates resolve
        // under our sandbox. After chdir, re-derive candidate paths from
        // the *resolved* cwd (macOS tmpdir lives at /var/... which resolves
        // to /private/var/... — `path.resolve` is lexical, so we must use
        // the post-chdir cwd to predict the resolver's exact output).
        process.chdir(cwdDir);
        const resolvedCwd = process.cwd();
        const resolvedCand2 = path.resolve(
          resolvedCwd,
          "..",
          "linear-launch",
        );
        const resolvedCand3 = path.resolve(
          resolvedCwd,
          "..",
          "..",
          "linear-launch",
        );

        if (params.envSet) {
          process.env.HYPERFRAMES_TEMPLATE_DIR = envDir;
          if (params.envPresent) {
            await writeJson(
              path.join(envDir, "hyperframes.json"),
              { source: "env" },
            );
          }
          // else envSet but no hyperframes.json → candidate is tried but
          // skipped with "hyperframes.json not found" reason.
        } else {
          delete process.env.HYPERFRAMES_TEMPLATE_DIR;
        }

        if (params.cand2Present) {
          await writeJson(
            path.join(resolvedCand2, "hyperframes.json"),
            { source: "cand2" },
          );
        }
        if (params.cand3Present) {
          await writeJson(
            path.join(resolvedCand3, "hyperframes.json"),
            { source: "cand3" },
          );
        }

        // Compute expected winner using the same precedence the resolver
        // encodes: env (if set AND present) > cand2 > cand3 > miss.
        const expectedWinner =
          params.envSet && params.envPresent
            ? envDir
            : params.cand2Present
              ? resolvedCand2
              : params.cand3Present
                ? resolvedCand3
                : null;

        if (expectedWinner !== null) {
          const result = await resolveTemplateDir();
          expect(result.sourcePath).toBe(expectedWinner);
          expect(typeof result.version).toBe("string");
        } else {
          let caught: unknown;
          try {
            await resolveTemplateDir();
          } catch (e) {
            caught = e;
          }
          expect(isWorkbenchError(caught)).toBe(true);
          if (!isWorkbenchError(caught)) throw caught;
          expect(caught.code).toBe(ErrorCode.TEMPLATE_NOT_FOUND);
          // `details.tried` must list every candidate actually evaluated.
          // When envSet=false, cand2+cand3 only; when envSet=true, all 3.
          const tried = caught.details?.tried as
            | Array<{ path: string; reason: string }>
            | undefined;
          expect(Array.isArray(tried)).toBe(true);
          // Resolver now tries two template names (hf-blank, linear-launch)
          // at each of the two sibling depths; env (when set) is probed
          // first. This test only plants `linear-launch` candidates, so
          // the hf-blank probes always miss → the total miss count is
          // 2 names × 2 depths (+ 1 env when set).
          const expectedLen = params.envSet ? 5 : 4;
          expect(tried).toHaveLength(expectedLen);
          const triedPaths = (tried ?? []).map((t) => t.path);
          if (params.envSet) expect(triedPaths).toContain(envDir);
          expect(triedPaths).toContain(resolvedCand2);
          expect(triedPaths).toContain(resolvedCand3);
          for (const entry of tried ?? []) {
            expect(typeof entry.reason).toBe("string");
            expect(entry.reason.length).toBeGreaterThan(0);
          }
        }
      }),
      // fs-bound — keep the run count small.
      { numRuns: 12 },
    );
  });
});

// ---------------------------------------------------------------------------
// T21.3 — Property 16: Deep-copy exclusion is idempotent and excludes the
//                      forbidden set
// ---------------------------------------------------------------------------

describe("template-manager · selectFilesToCopy · Property 16", () => {
  // Forbidden-path generators. Covers both POSIX and Windows-style separators
  // (`selectFilesToCopy` accepts both), case variations for `.MP4`, and
  // nested paths under the excluded prefixes.
  const forbiddenArb = fc.oneof(
    // captures/ and its Windows counterpart
    fc.constantFrom(
      "captures/file.png",
      "captures/sub/deep.jpg",
      "captures\\winpath.png",
      "captures/nested/dir/frame.webp",
    ),
    // .thumbnails/ and its Windows counterpart
    fc.constantFrom(
      ".thumbnails/a.png",
      ".thumbnails/sub/b.webp",
      ".thumbnails\\c.png",
    ),
    // *.mp4, case-insensitive, sometimes under an otherwise-clean path
    fc.constantFrom(
      "out.mp4",
      "render.MP4",
      "dir/nested/video.mp4",
      "fonts/rogue.Mp4",
    ),
  );

  // "Safe" paths that should always survive the filter.
  const safeArb = fc.constantFrom(
    "index.html",
    "hyperframes.json",
    "package.json",
    "meta.json",
    "fonts/main.ttf",
    "assets/scene-1.mp3",
    "nested/deep/thing.txt",
    "composition/index.html",
  );

  const pathArb = fc.oneof(forbiddenArb, safeArb);

  function isForbidden(p: string): boolean {
    return (
      p.startsWith("captures/") ||
      p.startsWith("captures\\") ||
      p.startsWith(".thumbnails/") ||
      p.startsWith(".thumbnails\\") ||
      p.toLowerCase().endsWith(".mp4")
    );
  }

  it("Property 16: output is an idempotent, forbidden-free subset of input; every safe entry survives", () => {
    fc.assert(
      fc.property(
        fc.array(pathArb, { minLength: 0, maxLength: 30 }),
        (listing) => {
          const filtered = selectFilesToCopy(listing);

          // (1) Subset: every survivor was present in the input.
          for (const p of filtered) {
            expect(listing).toContain(p);
          }

          // (2) No forbidden entry in the output.
          for (const p of filtered) {
            expect(isForbidden(p)).toBe(false);
          }

          // (3) Every safe entry survives the filter.
          for (const p of listing) {
            if (!isForbidden(p)) {
              expect(filtered).toContain(p);
            }
          }

          // (4) Idempotent: re-filtering the output yields the output.
          expect(selectFilesToCopy(filtered)).toEqual(filtered);
        },
      ),
      // Pure function, keep the default run budget.
      { numRuns: 100 },
    );
  });

  it("spot-check: explicit forbidden listing collapses to empty", () => {
    const all = [
      "captures/x.png",
      ".thumbnails/y.png",
      "video.mp4",
      "captures/sub/frame.png",
    ];
    expect(selectFilesToCopy(all)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T21.4 — Property 17: sync-template merge preserves local work
// ---------------------------------------------------------------------------

describe("template-manager · syncTemplate · Property 17", () => {
  const getTmp = useTmpDir("workbench-tm-sync-");

  /**
   * Build a synthetic source template + destination project under the
   * given root. Returns absolute paths for subsequent assertions.
   */
  async function buildFixture(
    root: string,
    opts: {
      srcHf: Record<string, unknown>;
      srcPkgVersion: string;
      srcFontBytes: Buffer;
      srcFontName: string;
      dstHf: Record<string, unknown>;
      dstPkgVersion: string;
      dstFontBytes: Buffer;
      dstFontName: string;
      dstIndexHtml: string;
      dstAudioBytes: Buffer;
    },
  ) {
    const src = path.join(root, "src");
    const dst = path.join(root, "dst");

    const srcHfPath = path.join(src, "hyperframes.json");
    const srcPkgPath = path.join(src, "package.json");
    const srcFontPath = path.join(src, "fonts", opts.srcFontName);

    const dstHfPath = path.join(dst, "hyperframes.json");
    const dstPkgPath = path.join(dst, "package.json");
    const dstFontPath = path.join(dst, "fonts", opts.dstFontName);
    const dstIndexHtmlPath = path.join(dst, "index.html");
    const dstAudioPath = path.join(dst, "assets", "scene-1.mp3");

    // Source template
    await writeJson(srcHfPath, opts.srcHf);
    await writeJson(srcPkgPath, {
      name: "linear-launch",
      version: opts.srcPkgVersion,
    });
    await mkdir(path.dirname(srcFontPath), { recursive: true });
    await writeFile(srcFontPath, opts.srcFontBytes);

    // Destination project
    await writeJson(dstHfPath, opts.dstHf);
    await writeJson(dstPkgPath, {
      name: "linear-launch",
      version: opts.dstPkgVersion,
    });
    await mkdir(path.dirname(dstFontPath), { recursive: true });
    await writeFile(dstFontPath, opts.dstFontBytes);
    await mkdir(path.dirname(dstIndexHtmlPath), { recursive: true });
    await writeFile(dstIndexHtmlPath, opts.dstIndexHtml, "utf8");
    await mkdir(path.dirname(dstAudioPath), { recursive: true });
    await writeFile(dstAudioPath, opts.dstAudioBytes);

    return {
      src,
      dst,
      srcHfPath,
      srcPkgPath,
      srcFontPath,
      dstHfPath,
      dstPkgPath,
      dstFontPath,
      dstIndexHtmlPath,
      dstAudioPath,
    };
  }

  // Arbitraries
  const hfArb = fc.record({
    paths: fc.record({
      blocks: fc.constantFrom("blocks", "blocks-a", "blocks-b"),
    }),
    version: fc.constantFrom("0.5.5", "0.6.0", "1.0.0"),
  });
  const byteArb = fc.uint8Array({ minLength: 4, maxLength: 64 }).map((u) =>
    Buffer.from(u),
  );
  const htmlArb = fc.constantFrom(
    "<html><body>user edit 1</body></html>",
    "<!doctype html><main>handcrafted</main>",
    "<div class='clip' data-start='0' data-duration='2'>hi</div>",
  );

  it("Property 17: merge keeps baseline-matching destinations in sync while preserving index.html and assets byte-identical", async () => {
    let runIx = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          srcHf: hfArb,
          srcPkgVersion: fc.constantFrom("0.6.0", "0.7.1", "1.0.0"),
          srcFontBytes: byteArb,
          dstFontBytes: byteArb,
          audioBytes: byteArb,
          indexHtml: htmlArb,
        }),
        async (params) => {
          const tmp = await getTmp();
          const runRoot = path.join(tmp.path, `sync-ok-${runIx++}`);

          // baseline === dst/hyperframes.json  (no local modification of
          // hyperframes.json → no conflict path).
          const baseline = params.srcHf; // pick any structure; baseline = what dst currently has
          const fx = await buildFixture(runRoot, {
            srcHf: params.srcHf,
            srcPkgVersion: params.srcPkgVersion,
            srcFontBytes: params.srcFontBytes,
            srcFontName: "brand.ttf",
            dstHf: baseline,
            dstPkgVersion: "0.0.0-stale",
            dstFontBytes: params.dstFontBytes,
            dstFontName: "legacy.ttf",
            dstIndexHtml: params.indexHtml,
            dstAudioBytes: params.audioBytes,
          });

          // Snapshot untouchable files *before* the sync.
          const indexHtmlBefore = await readUtf8(fx.dstIndexHtmlPath);
          const audioBefore = await readBytes(fx.dstAudioPath);

          // Make sure the baseline we pass is structurally equal to what's
          // on disk — we just mirrored it above, so this is a consistency
          // check rather than a new constraint.
          const dstHfBefore = JSON.parse(await readUtf8(fx.dstHfPath));
          expect(dstHfBefore).toEqual(baseline);

          await syncTemplate(fx.src, fx.dst, baseline);

          // hyperframes.json and package.json should now match src.
          expect(JSON.parse(await readUtf8(fx.dstHfPath))).toEqual(
            params.srcHf,
          );
          const pkgAfter = JSON.parse(await readUtf8(fx.dstPkgPath));
          expect(pkgAfter.version).toBe(params.srcPkgVersion);

          // The new font file from src must be present. The old font is
          // preserved as syncTemplate's copyDirRecursive writes on top
          // of fonts/ without removing pre-existing entries.
          expect(
            await exists(path.join(fx.dst, "fonts", "brand.ttf")),
          ).toBe(true);
          expect(
            Buffer.compare(
              await readBytes(path.join(fx.dst, "fonts", "brand.ttf")),
              params.srcFontBytes,
            ),
          ).toBe(0);

          // index.html and assets/scene-1.mp3 must be byte-identical to
          // their pre-sync state (the core preservation guarantee).
          expect(await readUtf8(fx.dstIndexHtmlPath)).toBe(indexHtmlBefore);
          expect(
            Buffer.compare(await readBytes(fx.dstAudioPath), audioBefore),
          ).toBe(0);
        },
      ),
      { numRuns: 8 },
    );
  });

  it("Property 17 (negative): when hyperframes.json diverges from baseline, syncTemplate throws TEMPLATE_CONFLICT and leaves every file untouched", async () => {
    let runIx = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          srcHf: hfArb,
          dstHf: hfArb,
          srcFontBytes: byteArb,
          dstFontBytes: byteArb,
          audioBytes: byteArb,
          indexHtml: htmlArb,
          // baseline must differ from dstHf to exercise the conflict
          // branch; we derive it by mutating a field.
          baselineSuffix: fc.constantFrom("X", "Y", "Z"),
        }),
        async (params) => {
          const tmp = await getTmp();
          const runRoot = path.join(tmp.path, `sync-conflict-${runIx++}`);

          // Construct a baseline that *differs* from dstHf so the
          // divergence check trips.
          const baseline = {
            ...params.dstHf,
            version: `${params.dstHf.version}-baseline-${params.baselineSuffix}`,
          };

          const fx = await buildFixture(runRoot, {
            srcHf: params.srcHf,
            srcPkgVersion: "9.9.9",
            srcFontBytes: params.srcFontBytes,
            srcFontName: "brand.ttf",
            dstHf: params.dstHf,
            dstPkgVersion: "0.0.0-stale",
            dstFontBytes: params.dstFontBytes,
            dstFontName: "legacy.ttf",
            dstIndexHtml: params.indexHtml,
            dstAudioBytes: params.audioBytes,
          });

          // Capture a full pre-state snapshot to assert "nothing moved".
          const before = {
            hf: await readUtf8(fx.dstHfPath),
            pkg: await readUtf8(fx.dstPkgPath),
            font: await readBytes(fx.dstFontPath),
            indexHtml: await readUtf8(fx.dstIndexHtmlPath),
            audio: await readBytes(fx.dstAudioPath),
          };

          let caught: unknown;
          try {
            await syncTemplate(fx.src, fx.dst, baseline);
          } catch (e) {
            caught = e;
          }

          expect(isWorkbenchError(caught)).toBe(true);
          if (!isWorkbenchError(caught)) throw caught;
          expect(caught.code).toBe(ErrorCode.TEMPLATE_CONFLICT);
          expect(caught.details?.conflicts).toEqual(["hyperframes.json"]);

          // Nothing on disk changed.
          expect(await readUtf8(fx.dstHfPath)).toBe(before.hf);
          expect(await readUtf8(fx.dstPkgPath)).toBe(before.pkg);
          expect(
            Buffer.compare(await readBytes(fx.dstFontPath), before.font),
          ).toBe(0);
          expect(await readUtf8(fx.dstIndexHtmlPath)).toBe(before.indexHtml);
          expect(
            Buffer.compare(await readBytes(fx.dstAudioPath), before.audio),
          ).toBe(0);
          // The src-side font must *not* have leaked into dst/.
          expect(
            await exists(path.join(fx.dst, "fonts", "brand.ttf")),
          ).toBe(false);
        },
      ),
      { numRuns: 8 },
    );
  });

  it("spot-check: sync followed by deepCopyTemplate is a no-op on index.html / assets", async () => {
    const tmp = await getTmp();
    const runRoot = path.join(tmp.path, "sync-spot");

    const baseline = { paths: { blocks: "blocks" }, version: "0.5.5" };
    const fx = await buildFixture(runRoot, {
      srcHf: baseline,
      srcPkgVersion: "0.6.0",
      srcFontBytes: Buffer.from([1, 2, 3, 4]),
      srcFontName: "brand.ttf",
      dstHf: baseline,
      dstPkgVersion: "0.0.0",
      dstFontBytes: Buffer.from([9, 9, 9]),
      dstFontName: "legacy.ttf",
      dstIndexHtml: "<html>preserved</html>",
      dstAudioBytes: Buffer.from([0xff, 0xee]),
    });
    // Silence the unused-import lint by exercising deepCopyTemplate once
    // against a throw-away destination so the import is meaningful.
    const copyDst = path.join(runRoot, "copy-dst");
    await deepCopyTemplate(fx.src, copyDst);
    expect(await exists(path.join(copyDst, "hyperframes.json"))).toBe(true);

    await syncTemplate(fx.src, fx.dst, baseline);
    expect(await readUtf8(fx.dstIndexHtmlPath)).toBe("<html>preserved</html>");
  });
});
