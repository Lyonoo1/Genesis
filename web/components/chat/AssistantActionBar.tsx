"use client";

import React, { useState } from "react";
import { Copy, Check, RotateCw, ThumbsUp, ThumbsDown } from "lucide-react";

interface AssistantActionBarProps {
  content: string;
  metrics?: {
    latency_ms?: number;
    tokens?: number;
  };
  timestamp?: string;
  onRegenerate?: () => void;
}

function formatTimestamp(dateStr?: string): string | null {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;

    const pad = (n: number) => String(n).padStart(2, "0");
    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  } catch {
    return null;
  }
}

export function AssistantActionBar({
  content,
  metrics,
  timestamp,
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

  const formattedTime = formatTimestamp(timestamp);
  const formattedLatency =
    metrics?.latency_ms !== undefined
      ? `${(metrics.latency_ms / 1000).toFixed(1)}s`
      : null;
  const formattedTokens =
    metrics?.tokens !== undefined ? `${metrics.tokens} tokens` : null;

  return (
    <div className="h-6 mt-3 flex items-center text-[#71717A] select-none">
      {/* 左侧操作按钮组与结束时间/耗时 */}
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

        {/* 点踩图标右侧：正常文字展示结束时间与纯耗时 */}
        {(formattedTime || formattedLatency || formattedTokens) && (
          <div className="flex items-center gap-1.5 ml-2 text-[11px] font-mono text-[#71717A]/80 tracking-tight">
            {formattedTime && <span>{formattedTime}</span>}
            {formattedTime && (formattedLatency || formattedTokens) && (
              <span>·</span>
            )}
            {formattedLatency && <span>{formattedLatency}</span>}
            {formattedLatency && formattedTokens && <span>·</span>}
            {formattedTokens && <span>{formattedTokens}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
