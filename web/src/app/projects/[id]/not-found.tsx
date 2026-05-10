/**
 * Not-found route for `/projects/[id]`.
 *
 * Triggered either by the Next.js router (invalid id segment) or by the
 * client page explicitly calling `notFound()` after the server returns
 * 404 for the project lookup.
 *
 * Satisfies the "项目不存在或无法读取" copy + back-link affordance in
 * Requirement 12.12.
 */

import Link from "next/link";

export default function ProjectNotFound(): React.JSX.Element {
  return (
    <main className="flex-1 px-6 py-16">
      <div className="mx-auto flex max-w-lg flex-col items-center gap-4 rounded-lg border border-border bg-muted/20 px-6 py-10 text-center">
        <h1 className="text-base font-semibold">项目不存在或无法读取</h1>
        <p className="text-sm text-muted-foreground">
          可能已被删除，或者 URL 输入有误。
        </p>
        <Link
          href="/projects"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          ← 返回项目列表
        </Link>
      </div>
    </main>
  );
}
