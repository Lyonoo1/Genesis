"use client";

import React, { useState } from "react";
import { Copy, Check, RotateCw, ThumbsUp, ThumbsDown } from "lucide-react";

interface AssistantActionBarProps {
  content: string;
  metrics?: {
    latency_ms?: number;
    tokens?: number;
  };
  onRegenerate?: () => void;
}

export function AssistantActionBar({
  content,
  metrics,
  onRegenerate,
}: AssistantActionBarProps) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<"like" | "dislike" | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback
    }
  };

  const formattedLatency =
    metrics?.latency_ms !== undefined
      ? `${(metrics.latency_ms / 1000).toFixed(1)}s`
      : null;
  const formattedTokens =
    metrics?.tokens !== undefined ? `${metrics.tokens} tokens` : null;

  return (
    <div className="h-6 mt-3 flex items-center justify-between text-[#71717A] select-none">
      {/* 左侧操作按钮组 (截图同款极简风格) */}
      <div className="flex items-center gap-0.5 -ml-1.5">
        <button
          onClick={handleCopy}
          className="p-1.5 rounded-md hover:bg-white/[0.08] hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
          title="复制整篇回复"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-white" />
              <span className="text-[10px] font-mono text-white">已复制</span>
            </>
          ) : (
            <Copy className="w-3.5 h-3.5 stroke-[1.8]" />
          )}
        </button>

        {onRegenerate && (
          <button
            onClick={onRegenerate}
            className="p-1.5 rounded-md hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
            title="重新生成"
          >
            <RotateCw className="w-3.5 h-3.5 stroke-[1.8]" />
          </button>
        )}

        <button
          onClick={() => setFeedback(feedback === "like" ? null : "like")}
          className={`p-1.5 rounded-md hover:bg-white/[0.08] transition-colors cursor-pointer ${
            feedback === "like"
              ? "text-white"
              : "hover:text-white"
          }`}
          title="好评"
        >
          <ThumbsUp className="w-3.5 h-3.5 stroke-[1.8]" />
        </button>

        <button
          onClick={() => setFeedback(feedback === "dislike" ? null : "dislike")}
          className={`p-1.5 rounded-md hover:bg-white/[0.08] transition-colors cursor-pointer ${
            feedback === "dislike"
              ? "text-red-400"
              : "hover:text-white"
          }`}
          title="差评"
        >
          <ThumbsDown className="w-3.5 h-3.5 stroke-[1.8]" />
        </button>
      </div>


      {/* 右侧耗时与 Token 统计徽标 */}
      {(formattedLatency || formattedTokens) && (
        <div className="text-[10px] font-mono text-genesis-muted/70 tracking-tight flex items-center gap-1.5 px-2 py-0.5 rounded bg-white/[0.02] border border-hairline/40">
          {formattedLatency && <span>{formattedLatency}</span>}
          {formattedLatency && formattedTokens && <span>·</span>}
          {formattedTokens && <span>{formattedTokens}</span>}
        </div>
      )}
    </div>
  );
}
