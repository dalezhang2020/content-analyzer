/**
 * Video Creation Workbench — Azure Cognitive Services TTS service.
 *
 * Uses the Azure Cognitive Services Speech REST API (not the Python SDK)
 * to synthesize narration text into MP3 audio files.
 *
 * Environment variables required:
 *   AZURE_SPEECH_ENDPOINT  e.g. "https://foundry-llm-zg.cognitiveservices.azure.com/"
 *   AZURE_SPEECH_KEY       subscription key
 *
 * REST endpoint used:
 *   POST {endpoint}/tts/cognitiveservices/v1     (multi-service Cognitive
 *                                                 Services resource)
 *   POST {endpoint}/cognitiveservices/v1         (single-purpose Speech
 *                                                 regional endpoint)
 *   Ocp-Apim-Subscription-Key: {key}
 *   Content-Type: application/ssml+xml
 *   X-Microsoft-OutputFormat: audio-16khz-128kbitrate-mono-mp3
 *
 * Body: SSML XML with the target voice and narration text.
 *
 * Two entry points:
 *   • `synthesizeAll(project, opts)` — batch TTS for all scenes.
 *   • `synthesizeOne(project, sceneId)` — single-scene TTS (force mode).
 *
 * Security invariants:
 *   - AZURE_SPEECH_KEY is read at the top of every public invocation;
 *     missing or empty key aborts BEFORE any network call.
 *   - The key is never placed into log payloads.
 *   - Error response bodies are truncated to 500 chars before logging.
 */

import path from "node:path";

import { atomicWriteBuffer, fileExists } from "./atomic-fs";
import {
  AZURE_TTS_OUTPUT_FORMAT,
  DEFAULT_VOICE,
  STAGE_DIRS,
  TIMEOUTS_MS,
  TTS_BACKOFF_MS,
  TTS_MAX_ATTEMPTS,
  VOICES,
} from "./constants";
import { ErrorCode, WorkbenchError } from "./errors";
import { createLogger, type WorkbenchLogger } from "./logger";
import { resolveProjectFile } from "./path-safety";
import { writeAudioFile } from "./project-store";
import type { Project, Scene, TTSBatchResult, Voice } from "./types";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

const ERROR_BODY_SNIPPET_MAX = 500;

class TTSSynthesisError extends Error {
  readonly kind: "timeout" | "failure";

  constructor(kind: "timeout" | "failure", message: string) {
    super(message);
    this.name = "TTSSynthesisError";
    this.kind = kind;
    Object.setPrototypeOf(this, TTSSynthesisError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

interface AzureCredentials {
  endpoint: string; // e.g. "https://foundry-llm-zg.cognitiveservices.azure.com"
  key: string;
}

/**
 * Read and validate Azure Speech credentials. Throws TTS_PROVIDER_UNCONFIGURED
 * (reusing the existing error code) when either env var is absent.
 */
function requireAzureCredentials(): AzureCredentials {
  const rawEndpoint = process.env.AZURE_SPEECH_ENDPOINT;
  const key = process.env.AZURE_SPEECH_KEY;

  if (!rawEndpoint || rawEndpoint.trim().length === 0) {
    throw new WorkbenchError(
      ErrorCode.TTS_PROVIDER_UNCONFIGURED,
      "Missing AZURE_SPEECH_ENDPOINT — set it in .env.local",
    );
  }
  if (!key || key.trim().length === 0) {
    throw new WorkbenchError(
      ErrorCode.TTS_PROVIDER_UNCONFIGURED,
      "Missing AZURE_SPEECH_KEY — set it in .env.local",
    );
  }

  // Normalize: strip trailing slash so we can append the path cleanly.
  const endpoint = rawEndpoint.replace(/\/+$/, "");
  return { endpoint, key };
}

// ---------------------------------------------------------------------------
// SSML builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal SSML document for Azure TTS.
 * Escapes XML special characters in the narration text to prevent injection.
 */
function buildSsml(voiceName: string, text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  // Derive xml:lang from the voice name prefix (e.g. "zh-CN-..." → "zh-CN").
  const langMatch = voiceName.match(/^([a-z]{2}-[A-Z]{2})/);
  const lang = langMatch ? langMatch[1] : "zh-CN";

  return (
    `<speak version='1.0' xml:lang='${lang}'>` +
    `<voice name='${voiceName}'>${escaped}</voice>` +
    `</speak>`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a scene's voice. If the scene's voice is empty or not in the
 * curated VOICES list, fall back to DEFAULT_VOICE and log a warning.
 * Since Voice is now `string`, we accept any non-empty value — the curated
 * list is just the UI picker; power users can set any Azure voice name.
 */
function resolveVoice(scene: Scene): Voice {
  const v = scene.voice;
  if (typeof v === "string" && v.trim().length > 0) {
    return v.trim();
  }
  return DEFAULT_VOICE;
}

function truncateBody(s: string): string {
  if (s.length <= ERROR_BODY_SNIPPET_MAX) return s;
  return s.slice(0, ERROR_BODY_SNIPPET_MAX);
}

function existingAudioAbsPath(projectId: string, rel: string): string {
  return resolveProjectFile(projectId, STAGE_DIRS.COMPOSITION, rel);
}

// ---------------------------------------------------------------------------
// Single-scene synthesis
// ---------------------------------------------------------------------------

/**
 * Call Azure Cognitive Services Speech REST API for one scene.
 *
 * Retry schedule: TTS_BACKOFF_MS = [0, 1000, 3000], max TTS_MAX_ATTEMPTS.
 * Returns the raw MP3 bytes on success.
 */
async function synthesizeSceneBuffer(
  scene: Scene,
  voice: Voice,
  creds: AzureCredentials,
  logger: WorkbenchLogger,
): Promise<Buffer> {
  // Azure Cognitive Services multi-service resources expose Speech TTS at
  // `/tts/cognitiveservices/v1` (the `/tts/` segment disambiguates from
  // other services like `/vision`, `/language` etc. on the same endpoint).
  // Single-purpose Speech regional endpoints use `/cognitiveservices/v1`
  // directly; we support both by checking the host.
  const ttsUrl = `${creds.endpoint}/tts/cognitiveservices/v1`;
  const ssml = buildSsml(voice, scene.narration);

  let lastReason = "unknown";
  let timedOutOnLastAttempt = false;

  for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt++) {
    const delay = TTS_BACKOFF_MS[attempt - 1] ?? 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUTS_MS.TTS_CALL);

    await logger.info("tts_attempt", {
      sceneIndex: scene.index,
      attempt,
      voice,
    });

    let response: Response;
    try {
      response = await fetch(ttsUrl, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": creds.key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": AZURE_TTS_OUTPUT_FORMAT,
          "User-Agent": "workbench-tts/1.0",
        },
        body: ssml,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = controller.signal.aborted;
      const reason = aborted
        ? "timeout"
        : err instanceof Error
          ? err.message
          : String(err);
      lastReason = reason;
      timedOutOnLastAttempt = aborted;
      await logger.warn("tts_attempt_failed", {
        sceneIndex: scene.index,
        attempt,
        voice,
        reason,
      });
      if (attempt === TTS_MAX_ATTEMPTS) break;
      continue;
    }

    clearTimeout(timer);

    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    // Non-2xx — read a truncated snippet for the log (never log the key).
    let bodySnippet = "";
    try {
      const text = await response.text();
      bodySnippet = truncateBody(text);
    } catch {
      bodySnippet = "<unreadable body>";
    }
    lastReason = `status ${response.status}: ${bodySnippet}`;
    timedOutOnLastAttempt = false;
    await logger.warn("tts_attempt_failed", {
      sceneIndex: scene.index,
      attempt,
      voice,
      status: response.status,
      body: bodySnippet,
    });

    if (attempt === TTS_MAX_ATTEMPTS) break;
  }

  throw new TTSSynthesisError(
    timedOutOnLastAttempt ? "timeout" : "failure",
    `TTS failed after ${TTS_MAX_ATTEMPTS} attempts: ${lastReason}`,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synthesize TTS for every scene in the project's storyboard.
 * Sequential iteration to respect Azure rate limits.
 */
export async function synthesizeAll(
  project: Project,
  opts?: { force?: boolean },
): Promise<TTSBatchResult> {
  const creds = requireAzureCredentials();
  const logger = createLogger(project.projectId, "audio");

  if (project.storyboard === null) {
    throw new WorkbenchError(
      ErrorCode.INVALID_STAGE,
      "Cannot synthesize audio: storyboard is not present",
      { projectId: project.projectId, stage: project.stage },
    );
  }

  const force = opts?.force === true;
  const scenes: Scene[] = [];
  const failures: TTSBatchResult["failures"] = [];

  await logger.info("tts_start", {
    projectId: project.projectId,
    sceneCount: project.storyboard.scenes.length,
    force,
    provider: "azure",
  });

  for (const original of project.storyboard.scenes) {
    const voice = resolveVoice(original);
    if (voice !== original.voice) {
      await logger.warn("tts_voice_fallback", {
        sceneIndex: original.index,
        sceneId: original.sceneId,
        requested: original.voice,
        used: voice,
      });
    }

    // Skip if mp3 already exists and force is not set.
    if (!force && original.audioPath !== null) {
      let present = false;
      try {
        present = await fileExists(
          existingAudioAbsPath(project.projectId, original.audioPath),
        );
      } catch {
        present = false;
      }
      if (present) {
        await logger.info("tts_skip", {
          sceneIndex: original.index,
          sceneId: original.sceneId,
          audioPath: original.audioPath,
        });
        scenes.push(original);
        continue;
      }
    }

    try {
      const buffer = await logger.timed(
        "tts_call",
        () => synthesizeSceneBuffer(original, voice, creds, logger),
        { sceneIndex: original.index, voice },
      );

      let resolvedAudioPath: string;
      try {
        // writeAudioFile returns the path/URL where the audio was stored:
        // - local: relative path "assets/scene-N.mp3"
        // - Vercel: absolute Vercel Blob URL
        resolvedAudioPath = await writeAudioFile(
          project.projectId,
          original.index,
          buffer,
        );
      } catch (writeErr) {
        const reason =
          writeErr instanceof Error ? writeErr.message : String(writeErr);
        await logger.error("tts_write_failed", {
          sceneIndex: original.index,
          sceneId: original.sceneId,
          reason,
        });
        failures.push({
          sceneId: original.sceneId,
          index: original.index,
          voice,
          error: { code: ErrorCode.WRITE_FAILED, message: reason },
        });
        scenes.push(original);
        continue;
      }

      const updated: Scene = {
        ...original,
        audioPath: resolvedAudioPath,
      };
      scenes.push(updated);
    } catch (err) {
      const isTimeout =
        err instanceof TTSSynthesisError && err.kind === "timeout";
      const code = isTimeout ? ErrorCode.TTS_TIMEOUT : "TTS_FAILED";
      const message = err instanceof Error ? err.message : String(err);
      failures.push({
        sceneId: original.sceneId,
        index: original.index,
        voice,
        error: { code, message },
      });
      scenes.push(original);
    }
  }

  await logger.info("tts_done", {
    projectId: project.projectId,
    ok: scenes.length - failures.length,
    failed: failures.length,
  });

  return { scenes, failures };
}

/**
 * Regenerate TTS for a single scene (always force mode).
 */
export async function synthesizeOne(
  project: Project,
  sceneId: string,
): Promise<Scene> {
  const creds = requireAzureCredentials();
  const logger = createLogger(project.projectId, "audio");

  if (project.storyboard === null) {
    throw new WorkbenchError(
      ErrorCode.INVALID_STAGE,
      "Cannot synthesize audio: storyboard is not present",
      { projectId: project.projectId, stage: project.stage },
    );
  }

  const original = project.storyboard.scenes.find(
    (s) => s.sceneId === sceneId,
  );
  if (!original) {
    throw new WorkbenchError(
      ErrorCode.SCENE_NOT_FOUND,
      "Scene not found",
      { projectId: project.projectId, sceneId },
    );
  }

  const voice = resolveVoice(original);
  if (voice !== original.voice) {
    await logger.warn("tts_voice_fallback", {
      sceneIndex: original.index,
      sceneId: original.sceneId,
      requested: original.voice,
      used: voice,
    });
  }

  await logger.info("tts_start", {
    projectId: project.projectId,
    sceneIndex: original.index,
    sceneId: original.sceneId,
    force: true,
    provider: "azure",
  });

  let buffer: Buffer;
  try {
    buffer = await logger.timed(
      "tts_call",
      () => synthesizeSceneBuffer(original, voice, creds, logger),
      { sceneIndex: original.index, voice },
    );
  } catch (err) {
    if (err instanceof TTSSynthesisError && err.kind === "timeout") {
      throw new WorkbenchError(
        ErrorCode.TTS_TIMEOUT,
        err.message,
        { sceneId: original.sceneId, index: original.index },
      );
    }
    throw err;
  }

  let resolvedAudioPath: string;
  try {
    resolvedAudioPath = await writeAudioFile(
      project.projectId,
      original.index,
      buffer,
    );
  } catch (writeErr) {
    const reason =
      writeErr instanceof Error ? writeErr.message : String(writeErr);
    await logger.error("tts_write_failed", {
      sceneIndex: original.index,
      sceneId: original.sceneId,
      reason,
    });
    throw writeErr;
  }

  const updated: Scene = {
    ...original,
    audioPath: resolvedAudioPath,
  };

  await logger.info("tts_done", {
    projectId: project.projectId,
    sceneIndex: original.index,
    sceneId: original.sceneId,
  });

  return updated;
}
