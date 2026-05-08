"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export interface BatchInputProps {
  onSubmit: (urls: string[]) => void;
  disabled?: boolean;
}

export function BatchInput({ onSubmit, disabled }: BatchInputProps) {
  const [text, setText] = useState("");

  const urls = text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const validCount = urls.filter((u) => /^https?:\/\/.+/i.test(u)).length;
  const tooMany = urls.length > 20;

  const handleSubmit = () => {
    const valid = urls.filter((u) => /^https?:\/\/.+/i.test(u));
    if (valid.length > 0) {
      onSubmit(valid);
    }
  };

  return (
    <div className="space-y-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"Paste URLs here (one per line or comma-separated)\nhttps://www.xiaohongshu.com/explore/...\nhttps://www.youtube.com/watch?v=..."}
        rows={6}
        disabled={disabled}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50 disabled:opacity-50 resize-y"
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {urls.length > 0 ? (
            <>
              {validCount} valid URL{validCount !== 1 ? "s" : ""}
              {tooMany && <span className="text-red-500 ml-2">(max 20)</span>}
            </>
          ) : (
            "No URLs entered"
          )}
        </span>
        <Button
          onClick={handleSubmit}
          disabled={disabled || validCount === 0 || tooMany}
          size="sm"
        >
          Analyze {validCount > 0 ? `${validCount} URLs` : ""}
        </Button>
      </div>
    </div>
  );
}
