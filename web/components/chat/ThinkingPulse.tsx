"use client";

import React from "react";

export function ThinkingPulse() {
  return (
    <div className="flex items-center gap-2 py-2 select-none">
      <div className="relative flex items-center justify-center w-3 h-3">
        <span className="absolute w-2 h-2 rounded-full bg-white/30 animate-ping" />
        <span className="relative w-1.5 h-1.5 rounded-full bg-neutral-300" />
      </div>
      <span className="text-xs font-mono text-codex-muted animate-pulse tracking-wide">
        思考中...
      </span>
    </div>
  );
}
