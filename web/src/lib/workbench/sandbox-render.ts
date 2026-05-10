/**
 * Vercel Sandbox-based video rendering.
 *
 * Architecture (critical for Vercel serverless):
 *   POST /render → bootstrap phase (sync):
 *     1. Create sandbox
 *     2. Upload composition HTML + scene HTMLs + audio files
 *     3. Install ffmpeg
 *     4. Kick off `npx hyperframes render ... --output output.mp4`
 *        with `detached: true` so the command keeps running inside the
 *        sandbox after this HTTP request ends.
 *     5. Persist sandboxId + cmdId to projects.render_job in Neon.
 *     6. Return 202 to caller.
 *
 *   GET /render/status → poll phase:
 *     1. Read projects.render_job for sandboxId + cmdId.
 *     2. Reconnect sandbox via Sandbox.get({ sandboxId }).
 *     3. Fetch command via sandbox.getCommand(cmdId).
 *     4. If exitCode === null → still running, return progress.
 *     5. If exitCode === 0 → download output.mp4, upload to Vercel Blob,
 *        persist video_blob_url, stop sandbox, return success.
 *     6. If exitCode !== 0 → read stderr, mark failure, stop sandbox.
 *
 * Bootstrap typically takes 60-120s (sandbox create + ffmpeg install +
 * chromium download via npx hyperframes), so POST must finish within the
 * Vercel function max duration. Set `maxDuration = 300` on the route.
 *
 * The render command itself runs inside the sandbox without counting
 * against Next.js function time, up to the sandbox timeout (30 min).
 */

import { Sandbox } from "@vercel/sandbox";
import { put } from "@vercel/blob";

import { sql, sqlOne } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types persisted on projects.render_job
// ---------------------------------------------------------------------------

export type RenderJobStatus =
  | "queued"
  | "preparing"
  | "rendering"
  | "uploading"
  | "succeeded"
  | "failed";

export interface RenderJob {
  jobId: string;
  sandboxId: string | null;
  cmdId: string | null;
  status: RenderJobStatus;
  message: string;
  progress: number; // 0..100
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  videoBlobUrl: string | null;
  error: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomJobId(): string {
  return `rjob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Neon helpers
// ---------------------------------------------------------------------------

async function updateRenderJob(
  projectId: string,
  patch: Partial<RenderJob>,
): Promise<void> {
  const row = await sqlOne<{ render_job: RenderJob | null }>`
    SELECT render_job FROM content_analyzer.projects WHERE project_id = ${projectId}
  `;
  const current = row?.render_job ?? null;
  const next: RenderJob = {
    jobId: patch.jobId ?? current?.jobId ?? randomJobId(),
    sandboxId:
      patch.sandboxId !== undefined
        ? patch.sandboxId
        : current?.sandboxId ?? null,
    cmdId: patch.cmdId !== undefined ? patch.cmdId : current?.cmdId ?? null,
    status: patch.status ?? current?.status ?? "queued",
    message: patch.message ?? current?.message ?? "",
    progress: patch.progress ?? current?.progress ?? 0,
    startedAt: current?.startedAt ?? nowIso(),
    updatedAt: nowIso(),
    finishedAt:
      patch.finishedAt !== undefined
        ? patch.finishedAt
        : current?.finishedAt ?? null,
    videoBlobUrl:
      patch.videoBlobUrl !== undefined
        ? patch.videoBlobUrl
        : current?.videoBlobUrl ?? null,
    error: patch.error !== undefined ? patch.error : current?.error ?? null,
  };
  if (patch.videoBlobUrl) {
    await sql`
      UPDATE content_analyzer.projects
      SET render_job = ${JSON.stringify(next)}::jsonb,
          video_blob_url = ${patch.videoBlobUrl},
          updated_at = NOW()
      WHERE project_id = ${projectId}
    `;
  } else {
    await sql`
      UPDATE content_analyzer.projects
      SET render_job = ${JSON.stringify(next)}::jsonb,
          updated_at = NOW()
      WHERE project_id = ${projectId}
    `;
  }
}

// Alias kept for call sites that were already using it.
const updateRenderJobSafe = updateRenderJob;

export async function getRenderJob(
  projectId: string,
): Promise<RenderJob | null> {
  const row = await sqlOne<{ render_job: RenderJob | null }>`
    SELECT render_job FROM content_analyzer.projects WHERE project_id = ${projectId}
  `;
  return row?.render_job ?? null;
}

// ---------------------------------------------------------------------------
// Fetch project inputs from Neon + Blob
// ---------------------------------------------------------------------------

interface ProjectInputs {
  indexHtml: string;
  scenes: Array<{
    filename: string;
    html: string;
  }>;
  audio: Array<{
    filename: string;
    buffer: Buffer;
  }>;
  totalDurationSec: number;
}

async function fetchProjectInputs(projectId: string): Promise<ProjectInputs> {
  // Project row
  const proj = await sqlOne<{
    index_html_content: string | null;
  }>`
    SELECT index_html_content
    FROM content_analyzer.projects
    WHERE project_id = ${projectId}
  `;
  if (!proj?.index_html_content) {
    throw new Error("index.html not found in Neon — run composition stage first");
  }

  // Scenes: read HTML and audio URLs
  const sceneRows = await sql<{
    scene_id: string;
    scene_index: number;
    duration_sec: number;
    html_content: string | null;
    audio_blob_url: string | null;
    audio_path: string | null;
  }>`
    SELECT scene_id, scene_index, duration_sec, html_content,
           audio_blob_url, audio_path
    FROM content_analyzer.scenes
    WHERE project_id = ${projectId}
    ORDER BY scene_index
  `;
  if (sceneRows.length === 0) {
    throw new Error("No scenes found — run storyboard + composition first");
  }

  // Assemble scene files: the filename must match whatever index.html
  // references in compositions/scene-NN-xxxxxx.html. We reconstruct the
  // filename from scene_index + last 6 hex chars of scene_id.
  const scenes: ProjectInputs["scenes"] = [];
  for (const s of sceneRows) {
    if (!s.html_content) {
      throw new Error(`Scene ${s.scene_index} has no html_content in Neon`);
    }
    const hexTail = s.scene_id.slice(3, 9); // sc_XXXXXX...
    const idx = String(s.scene_index).padStart(2, "0");
    scenes.push({
      filename: `scene-${idx}-${hexTail}.html`,
      html: s.html_content,
    });
  }

  // Fetch audio from blob URLs in parallel
  const audio: ProjectInputs["audio"] = await Promise.all(
    sceneRows.map(async (s) => {
      const url =
        s.audio_blob_url ??
        (s.audio_path && (s.audio_path.startsWith("http://") || s.audio_path.startsWith("https://"))
          ? s.audio_path
          : null);
      if (!url) {
        throw new Error(`Scene ${s.scene_index} has no audio URL — run audio stage first`);
      }
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch audio for scene ${s.scene_index}: ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        filename: `scene-${s.scene_index}.mp3`,
        buffer: buf,
      };
    }),
  );

  const totalDurationSec = sceneRows.reduce((sum, s) => sum + s.duration_sec, 0);

  return {
    indexHtml: proj.index_html_content,
    scenes,
    audio,
    totalDurationSec,
  };
}

// ---------------------------------------------------------------------------
// Sandbox orchestration
// ---------------------------------------------------------------------------

/**
 * Bootstrap phase (runs inside POST /render handler on Vercel):
 *   - Create sandbox, upload files, install ffmpeg, kick off detached
 *     render command, persist {sandboxId, cmdId} to Neon, return.
 *
 * This function MUST complete within the Vercel function max duration
 * (~300s). Typical bootstrap: 60-120s.
 *
 * The render command itself keeps running inside the sandbox after this
 * function returns, and is polled by checkRenderProgress().
 */
export async function bootstrapRenderSandbox(projectId: string): Promise<void> {
  let sandbox: Sandbox | null = null;
  try {
    await updateRenderJob(projectId, {
      status: "preparing",
      message: "Fetching project assets from Neon and Blob",
      progress: 5,
    });

    const inputs = await fetchProjectInputs(projectId);

    await updateRenderJob(projectId, {
      status: "preparing",
      message: `Creating sandbox for ${inputs.scenes.length}-scene, ${inputs.totalDurationSec}s render`,
      progress: 10,
    });

    sandbox = await Sandbox.create({
      runtime: "node24",
      resources: { vcpus: 4 },
      timeout: 30 * 60 * 1000, // 30 minutes — enough for a long render
    });

    await updateRenderJob(projectId, {
      sandboxId: sandbox.sandboxId,
      status: "preparing",
      message: "Uploading composition files to sandbox",
      progress: 15,
    });

    // Prepare all files
    const filesToWrite: Array<{ path: string; content: Buffer }> = [
      {
        path: "render/index.html",
        content: Buffer.from(inputs.indexHtml, "utf8"),
      },
      {
        path: "render/hyperframes.json",
        content: Buffer.from(
          JSON.stringify(
            {
              $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
              paths: {
                blocks: "compositions",
                components: "compositions/components",
                assets: "assets",
              },
            },
            null,
            2,
          ),
          "utf8",
        ),
      },
      {
        path: "render/package.json",
        content: Buffer.from(
          JSON.stringify(
            {
              name: "content-analyzer-render",
              private: true,
              type: "module",
            },
            null,
            2,
          ),
          "utf8",
        ),
      },
    ];
    for (const scene of inputs.scenes) {
      filesToWrite.push({
        path: `render/compositions/${scene.filename}`,
        content: Buffer.from(scene.html, "utf8"),
      });
    }
    for (const audio of inputs.audio) {
      filesToWrite.push({
        path: `render/assets/${audio.filename}`,
        content: audio.buffer,
      });
    }
    await sandbox.writeFiles(filesToWrite);

    await updateRenderJob(projectId, {
      status: "preparing",
      message: "Installing ffmpeg",
      progress: 25,
    });

    // Install ffmpeg (Amazon Linux 2023)
    const installFfmpeg = await sandbox.runCommand({
      cmd: "sudo",
      args: ["dnf", "install", "-y", "ffmpeg-free"],
      cwd: "/vercel/sandbox",
    });
    if (installFfmpeg.exitCode !== 0) {
      const stderrText = await installFfmpeg.stderr();
      console.warn(
        "[sandbox-render] dnf ffmpeg install non-zero exit:",
        stderrText.slice(0, 500),
      );
    }

    await updateRenderJob(projectId, {
      status: "rendering",
      message: "Running hyperframes render (can take several minutes)",
      progress: 40,
    });

    // Kick off the render detached so we don't have to wait for it in this
    // HTTP request. The command keeps running inside the sandbox after we
    // return. checkRenderProgress() re-fetches the command by its ID.
    const renderCmd = await sandbox.runCommand({
      cmd: "npx",
      args: [
        "--yes",
        "hyperframes@0.5.5",
        "render",
        "--output",
        "output.mp4",
        "--quality",
        "standard",
        "--workers",
        "auto",
      ],
      cwd: "/vercel/sandbox/render",
      detached: true,
    });

    await updateRenderJob(projectId, {
      cmdId: renderCmd.cmdId,
      status: "rendering",
      message: "Render command started in sandbox",
      progress: 45,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sandbox-render] bootstrap failed:", message);
    await updateRenderJob(projectId, {
      status: "failed",
      message: "Render bootstrap failed",
      error: message.slice(0, 2000),
      finishedAt: nowIso(),
    });
    try {
      await sql`
        UPDATE content_analyzer.projects
        SET stage_status = jsonb_set(
          jsonb_set(
            COALESCE(stage_status, '{}'::jsonb),
            '{render,status}',
            '"failed"'
          ),
          '{render,lastError}',
          to_jsonb(${message.slice(0, 500)}::text)
        ),
        updated_at = NOW()
        WHERE project_id = ${projectId}
      `;
    } catch {
      /* ignore */
    }
    if (sandbox) {
      try {
        await sandbox.stop();
      } catch {
        /* ignore */
      }
    }
    throw err;
  }
}

/**
 * Poll phase (called by GET /render/status).
 *
 * Checks the detached render command's status. When it finishes:
 *   - On success: downloads MP4 from sandbox, uploads to Vercel Blob,
 *     persists video_blob_url, stops the sandbox.
 *   - On failure: reads stderr, marks failure, stops the sandbox.
 *
 * Returns the (possibly just-updated) RenderJob so the HTTP handler can
 * hand it straight back to the client.
 */
export async function checkRenderProgress(
  projectId: string,
): Promise<RenderJob | null> {
  const job = await getRenderJob(projectId);
  if (!job) return null;

  // Terminal states — nothing to do, just return cached state.
  if (job.status === "succeeded" || job.status === "failed") {
    return job;
  }

  // Not yet detached — bootstrap still running. Return as-is; the
  // bootstrap handler will update render_job when it finishes.
  if (!job.sandboxId || !job.cmdId) {
    return job;
  }

  // Reconnect sandbox + command.
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.get({ sandboxId: job.sandboxId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sandbox-render] failed to get sandbox:", message);
    await updateRenderJob(projectId, {
      status: "failed",
      message: "Lost connection to render sandbox",
      error: message.slice(0, 500),
      finishedAt: nowIso(),
    });
    return await getRenderJob(projectId);
  }

  let cmd;
  try {
    cmd = await sandbox.getCommand(job.cmdId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sandbox-render] failed to get command:", message);
    await updateRenderJob(projectId, {
      status: "failed",
      message: "Lost render command handle",
      error: message.slice(0, 500),
      finishedAt: nowIso(),
    });
    try {
      await sandbox.stop();
    } catch {
      /* ignore */
    }
    return await getRenderJob(projectId);
  }

  // Still running
  if (cmd.exitCode === null) {
    return job;
  }

  // Command finished. Handle success/failure.
  if (cmd.exitCode === 0) {
    try {
      await updateRenderJob(projectId, {
        status: "uploading",
        message: "Downloading MP4 and uploading to Blob",
        progress: 85,
      });

      const mp4Buffer = await sandbox.readFileToBuffer({
        path: "/vercel/sandbox/render/output.mp4",
      });
      if (!mp4Buffer) {
        throw new Error("Render completed but output.mp4 not found in sandbox");
      }

      const blobPath = `video/${projectId}/output.mp4`;
      const { url: videoBlobUrl } = await put(blobPath, mp4Buffer, {
        access: "public",
        contentType: "video/mp4",
        addRandomSuffix: false,
        allowOverwrite: true,
      });

      await sql`
        UPDATE content_analyzer.projects
        SET video_blob_url = ${videoBlobUrl},
            artifacts = jsonb_set(
              COALESCE(artifacts, '{}'::jsonb),
              '{videoPath}',
              to_jsonb(${videoBlobUrl}::text)
            ),
            stage = 'render',
            stage_status = jsonb_set(
              jsonb_set(
                COALESCE(stage_status, '{}'::jsonb),
                '{render,status}',
                '"succeeded"'
              ),
              '{render,finishedAt}',
              to_jsonb(to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
            ),
            updated_at = NOW()
        WHERE project_id = ${projectId}
      `;

      await updateRenderJob(projectId, {
        status: "succeeded",
        message: "Render complete",
        progress: 100,
        finishedAt: nowIso(),
        videoBlobUrl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[sandbox-render] upload phase failed:", message);
      await updateRenderJob(projectId, {
        status: "failed",
        message: "Post-render upload failed",
        error: message.slice(0, 2000),
        finishedAt: nowIso(),
      });
    } finally {
      try {
        await sandbox.stop();
      } catch {
        /* ignore */
      }
    }
  } else {
    // Non-zero exit — gather stderr and mark failure.
    try {
      const stderrText = await cmd.stderr();
      const stdoutText = await cmd.stdout();
      const snippet =
        stderrText.slice(0, 2000) || stdoutText.slice(-2000) || `exit ${cmd.exitCode}`;
      await updateRenderJob(projectId, {
        status: "failed",
        message: "hyperframes render failed",
        error: `exit ${cmd.exitCode}: ${snippet}`,
        finishedAt: nowIso(),
      });
      await sql`
        UPDATE content_analyzer.projects
        SET stage_status = jsonb_set(
          jsonb_set(
            COALESCE(stage_status, '{}'::jsonb),
            '{render,status}',
            '"failed"'
          ),
          '{render,lastError}',
          to_jsonb(${snippet.slice(0, 500)}::text)
        ),
        updated_at = NOW()
        WHERE project_id = ${projectId}
      `;
    } catch (err) {
      console.error("[sandbox-render] failed to read stderr:", err);
    } finally {
      try {
        await sandbox.stop();
      } catch {
        /* ignore */
      }
    }
  }

  return await getRenderJob(projectId);
}

/**
 * Initialize a fresh render job record in Neon. Called from POST /render
 * before bootstrapping the sandbox.
 */
export async function startRenderJob(projectId: string): Promise<RenderJob> {
  const jobId = randomJobId();
  const now = nowIso();
  const initial: RenderJob = {
    jobId,
    sandboxId: null,
    cmdId: null,
    status: "queued",
    message: "Queued",
    progress: 0,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    videoBlobUrl: null,
    error: null,
  };
  await sql`
    UPDATE content_analyzer.projects
    SET render_job = ${JSON.stringify(initial)}::jsonb,
        stage_status = jsonb_set(
          jsonb_set(
            COALESCE(stage_status, '{}'::jsonb),
            '{render,status}',
            '"running"'
          ),
          '{render,startedAt}',
          to_jsonb(${now}::text)
        ),
        updated_at = NOW()
    WHERE project_id = ${projectId}
  `;
  return initial;
}
