"use client";

/**
 * Error boundary for `/projects/[id]`.
 *
 * Next.js mounts this component whenever the page throws during render or
 * a nested Server Component fails. It receives the caught `Error` and a
 * `reset()` callback that re-renders the segment.
 *
 * The copy mirrors Requirement 12.12 — "项目不存在或无法读取" — but as a
 * more generic "出错了" banner since this boundary catches any render-time
 * error, not just not-found. The explicit 404 flow uses the adjacent
 * `not-found.tsx`.
 */

import { useEffect } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function ProjectDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  useEffect(() => {
    // Surface unexpected render errors in the browser console during dev;
    // production logging happens server-side via the unified error logger.
    // eslint-disable-next-line no-console
    console.error("/projects/[id] render error:", error);
  }, [error]);

  return (
    <main className="flex-1 px-6 py-16">
      <div
        className="mx-auto flex max-w-lg flex-col items-center gap-4 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-10 text-center"
        role="alert"
      >
        <h1 className="text-base font-semibold text-destructive">
          项目详情加载失败
        </h1>
        <p className="text-sm text-muted-foreground">
          {error.message || "出现了意料之外的错误，请稍后重试。"}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={reset}>
            重试
          </Button>
          <Link
            href="/projects"
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            返回项目列表
          </Link>
        </div>
      </div>
    </main>
  );
}
