"use client";

import React, { useState, useEffect, useRef } from "react";

interface ThinkingPulseProps {
  createdAt?: string;
}

export function ThinkingPulse({ createdAt }: ThinkingPulseProps) {
  const startRef = useRef<number>(Date.now());
  const [seconds, setSeconds] = useState(0.1);

  useEffect(() => {
    const parsed = createdAt ? new Date(createdAt).getTime() : NaN;
    const start = !isNaN(parsed) && Math.abs(Date.now() - parsed) < 600000 ? parsed : Date.now();
    startRef.current = start;

    const interval = setInterval(() => {
      const elapsed = (Date.now() - startRef.current) / 1000;
      setSeconds(Math.max(0.1, elapsed));
    }, 100);

    return () => clearInterval(interval);
  }, [createdAt]);

  return (
    <div className="flex items-center gap-2 py-2 select-none">
      <div className="relative flex items-center justify-center w-3 h-3">
        <span className="absolute w-2 h-2 rounded-full bg-white/30 animate-ping" />
        <span className="relative w-1.5 h-1.5 rounded-full bg-neutral-300" />
      </div>
      <span className="text-xs font-mono text-codex-muted tracking-wide flex items-center gap-1">
        <span>思考中</span>
        <span className="tabular-nums text-zinc-400">({seconds.toFixed(1)}s)</span>
        <span>...</span>
      </span>
    </div>
  );
}
