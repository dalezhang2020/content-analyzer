/**
 * Environment detection helpers.
 *
 * `isLocalEnv()` returns true when the app is running on the local Mac
 * with access to Python venv, kiro-cli, and HyperFrames CLI.
 *
 * On Vercel, these tools are not available — routes that depend on them
 * should return 503 with a clear message.
 */

/**
 * True when running locally (not on Vercel / CI).
 * Checks for VERCEL env var (set automatically by Vercel) and
 * IS_LOCAL env var (can be set manually for local dev).
 */
export function isLocalEnv(): boolean {
  // Vercel sets VERCEL=1 automatically
  if (process.env.VERCEL) return false;
  // CI environments
  if (process.env.CI) return false;
  // Explicit override
  if (process.env.IS_LOCAL === "false") return false;
  return true;
}

/**
 * Standard 503 response for routes that require local tools.
 */
export function localOnlyResponse(feature: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "LOCAL_ONLY",
        message: `${feature} requires local tools (Python/kiro-cli/HyperFrames) and is not available on Vercel. Run locally to use this feature.`,
      },
    }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" },
    },
  );
}
