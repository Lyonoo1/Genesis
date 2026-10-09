"use client";

import React, { useState } from "react";
import {
  ChevronRight,
  Terminal,
  Check,
  X,
  Loader2,
  Copy,
} from "lucide-react";

interface ToolCallAccordionProps {
  toolCall: {
    id: string;
    name: string;
    args?: Record<string, unknown>;
  };
  toolResult?: {
    output?: unknown;
    error?: string;
    latencyMs?: number;
  };
}

export function ToolCallAccordion({
  toolCall,
  toolResult,
}: ToolCallAccordionProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);

  // 状态推导：运行中 / 成功 / 失败
  const status: "running" | "success" | "failed" = !toolResult
    ? "running"
    : toolResult.error
    ? "failed"
    : "success";

  const latency = toolResult?.latencyMs ? `${toolResult.latencyMs}ms` : null;

  const rawOutputString = toolResult?.error
    ? `Error: ${toolResult.error}`
    : typeof toolResult?.output === "object"
    ? JSON.stringify(toolResult?.output, null, 2)
    : toolResult?.output
    ? String(toolResult?.output)
    : "";

  const handleCopyOutput = async () => {
    if (!rawOutputString) return;
    try {
      await navigator.clipboard.writeText(rawOutputString);
      setCopiedOutput(true);
      setTimeout(() => setCopiedOutput(false), 1500);
    } catch {
      // fallback
    }
  };

  return (
    <div className="my-2.5 rounded-lg border border-hairline bg-[#18181C] overflow-hidden transition-all duration-150 shadow-sm select-none">
      {/* 1. 胶囊卡片头部 (收起态: 32px 高度) */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="h-8 px-3 flex items-center justify-between cursor-pointer hover:bg-white/[0.03] transition-colors"
      >
        {/* 左侧状态区与工具名称 */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* 状态指示器 */}
          {status === "running" && (
            <Loader2 className="w-3 h-3 text-codex-muted animate-spin shrink-0" />
          )}
          {status === "success" && (
            <div className="w-3.5 h-3.5 rounded-full bg-white/[0.1] flex items-center justify-center shrink-0">
              <Check className="w-2.5 h-2.5 text-white" />
            </div>
          )}
          {status === "failed" && (
            <div className="w-3.5 h-3.5 rounded-full bg-red-500/20 flex items-center justify-center shrink-0">
              <X className="w-2.5 h-2.5 text-red-400" />
            </div>
          )}

          {/* 标题文本 */}
          <div className="font-mono text-xs truncate flex items-center gap-1.5">
            <span className="text-codex-muted font-normal">工具调用:</span>
            <span className="font-medium text-white">
              {toolCall.name}
            </span>
          </div>
        </div>

        {/* 右侧指标区与旋转 Chevron */}
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {latency && (
            <span className="font-mono text-[11px] text-codex-muted">
              {latency}
            </span>
          )}
          <ChevronRight
            className={`w-3.5 h-3.5 text-codex-muted transition-transform duration-200 ${
              isOpen ? "rotate-90 text-white" : ""
            }`}
          />
        </div>
      </div>

      {/* 2. 展开态黑色终端面板 */}
      {isOpen && (
        <div className="border-t border-hairline bg-[#121215] p-3 space-y-3 font-mono text-xs select-text animate-in fade-in duration-150">
          {/* Parameters JSON */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-[11px] text-codex-muted uppercase tracking-wider font-semibold">
              <Terminal className="w-3 h-3 text-codex-muted" />
              <span>Parameters</span>
            </div>
            <pre className="p-2.5 rounded-lg bg-black/40 border border-hairline/60 overflow-x-auto text-[#ECECEE] text-[12px] leading-relaxed scrollbar-thin">
              <code>{JSON.stringify(toolCall.args || {}, null, 2)}</code>
            </pre>
          </div>

          {/* Execution Output */}
          {rawOutputString && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-codex-muted uppercase tracking-wider font-semibold">
                <span>Execution Output</span>
                <button
                  onClick={handleCopyOutput}
                  className="flex items-center gap-1 text-[10px] text-codex-muted hover:text-white px-1.5 py-0.5 rounded hover:bg-white/[0.04] transition-colors"
                  title="复制工具返回值"
                >
                  {copiedOutput ? (
                    <>
                      <Check className="w-2.5 h-2.5 text-white" />
                      <span className="text-white">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-2.5 h-2.5" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="p-2.5 rounded-lg bg-black/40 border border-hairline/60 max-h-[200px] overflow-y-auto overflow-x-auto text-codex-muted text-[12px] leading-relaxed scrollbar-thin">
                <code>{rawOutputString}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
