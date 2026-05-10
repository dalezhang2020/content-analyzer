"use client";

/**
 * StageBadge — renders a `StageStatusValue` as a colored badge with icon.
 *
 * Visual mapping:
 *   pending   → gray outline
 *   running   → blue, Loader2 spinner
 *   succeeded → green, Check
 *   failed    → red, XCircle
 *   skipped   → amber, MinusCircle
 *
 * Built on top of the shared `Badge` primitive; all color styling is layered
 * on via className so we stay compatible with both light/dark themes.
 */

import { Check, Loader2, MinusCircle, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { StageStatusValue } from "@/lib/workbench/types";

export interface StageBadgeProps {
  status: StageStatusValue;
  className?: string;
}

interface StyleConfig {
  label: string;
  className: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
}

const STATUS_STYLES: Record<StageStatusValue, StyleConfig> = {
  pending: {
    label: "待处理",
    className:
      "bg-muted text-muted-foreground border-border",
    icon: MinusCircle,
    iconClassName: "opacity-60",
  },
  running: {
    label: "运行中",
    className:
      "bg-blue-500/10 text-blue-600 border-blue-500/20 dark:text-blue-400",
    icon: Loader2,
    iconClassName: "animate-spin",
  },
  succeeded: {
    label: "已完成",
    className:
      "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
    icon: Check,
  },
  failed: {
    label: "失败",
    className:
      "bg-destructive/10 text-destructive border-destructive/20",
    icon: XCircle,
  },
  skipped: {
    label: "已跳过",
    className:
      "bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400",
    icon: MinusCircle,
  },
};

export function StageBadge({ status, className }: StageBadgeProps): React.JSX.Element {
  const style = STATUS_STYLES[status];
  const Icon = style.icon;

  return (
    <Badge
      variant="outline"
      className={cn("gap-1", style.className, className)}
      aria-label={`状态: ${style.label}`}
    >
      <Icon className={cn(style.iconClassName)} />
      <span>{style.label}</span>
    </Badge>
  );
}
