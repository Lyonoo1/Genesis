"use client";

import React, { useState, useMemo, useEffect, useRef } from "react";
import { ChevronDown, Loader2, X, CheckCircle2, Layers } from "lucide-react";
import { ToolCallItem } from "@/types";
import { ActionTimelineEntry } from "./ActionTimelineEntry";

interface ActionTimelineProps {
  toolCalls: ToolCallItem[];
  isStreaming?: boolean;
  hasContent?: boolean;
  durationMs?: number;
  sessionId?: string;
}

interface GroupedToolEntry {
  toolCall: ToolCallItem;
  repeatCount: number;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${Math.max(0.1, totalSeconds).toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

function buildActionSummary(toolCalls: ToolCallItem[]): string {
  let reads = 0;
  let searches = 0;
  let edits = 0;
  let execs = 0;
  let subagents = 0;

  for (const tc of toolCalls) {
    const name = tc.name || "";
    if (name.includes("write_file") || name.includes("create_file") || name.includes("edit_file")) {
      edits++;
    } else if (name.includes("read_file") || name.includes("list_dir")) {
      reads++;
    } else if (name.includes("grep") || name.includes("find")) {
      searches++;
    } else if (name.includes("execute_command") || name.includes("exec_command") || name.includes("write_stdin")) {
      execs++;
    } else if (name.includes("dispatch_subagent") || name.includes("spawn_agent")) {
      subagents++;
    }
  }

  const parts: string[] = [];
  if (reads > 0) parts.push(`读取 ${reads} 次`);
  if (searches > 0) parts.push(`检索 ${searches} 次`);
  if (edits > 0) parts.push(`编辑 ${edits} 处`);
  if (execs > 0) parts.push(`命令 ${execs} 条`);
  if (subagents > 0) parts.push(`子代理 ${subagents} 个`);

  if (parts.length === 0) {
    return `${toolCalls.length} 项操作`;
  }
  return `执行 ${toolCalls.length} 步操作（${parts.join(" · ")}）`;
}

function getMergeKey(tc: ToolCallItem): string | null {
  const name = tc.name || "";
  if (name.includes("read_file") || name.includes("list_dir")) {
    const p = String(tc.args?.path || "").trim();
    return p ? `${name}::${p}` : null;
  }
  return null;
}

export function ActionTimeline({
  toolCalls,
  isStreaming = false,
  hasContent = false,
  durationMs,
  sessionId,
}: ActionTimelineProps) {
  const nonTodoCalls = useMemo(
    () => toolCalls.filter((tc) => !tc.name.includes("todo_write")),
    [toolCalls]
  );

  const callsToRender = nonTodoCalls.length > 0 ? nonTodoCalls : toolCalls.slice(0, 1);

  // 合并相邻的同文件重复读取，减少刷屏噪音
  const groupedCalls = useMemo<GroupedToolEntry[]>(() => {
    const result: GroupedToolEntry[] = [];
    for (const tc of callsToRender) {
      const key = getMergeKey(tc);
      const prev = result[result.length - 1];
      if (key && prev && getMergeKey(prev.toolCall) === key) {
        prev.repeatCount += 1;
        // 保留最新一条的状态与输出
        prev.toolCall = tc;
      } else {
        result.push({ toolCall: tc, repeatCount: 1 });
      }
    }
    return result;
  }, [callsToRender]);

  const finishedCount = toolCalls.filter(
    (t) => t.output !== undefined || t.status === "success" || t.status === "failed"
  ).length;
  const isAllDone = !isStreaming || finishedCount >= toolCalls.length;
  const hasError = toolCalls.some((t) => t.status === "failed");

  // 智能折叠策略：
  // - 步骤 <= 4 时默认展开，保持直观；
  // - 超过 4 步且本轮已产出正文或已结束时自动折叠为单行摘要，把视觉重心让给正文结论；
  // - 用户手动点击后始终尊重用户选择。
  const shouldAutoCollapse =
    groupedCalls.length > 4 && (!isStreaming || hasContent);
  const [isOpen, setIsOpen] = useState(!shouldAutoCollapse);
  const userToggledRef = useRef(false);

  useEffect(() => {
    if (!userToggledRef.current && shouldAutoCollapse) {
      setIsOpen(false);
    }
  }, [shouldAutoCollapse]);

  const handleToggle = () => {
    userToggledRef.current = true;
    setIsOpen((prev) => !prev);
  };

  const totalDuration = useMemo(() => {
    if (durationMs) return durationMs / 1000;
    const sumMs = toolCalls.reduce((acc, cur) => acc + (cur.latency_ms || 0), 0);
    return sumMs > 0 ? sumMs / 1000 : 0;
  }, [toolCalls, durationMs]);

  const actionSummary = useMemo(() => buildActionSummary(nonTodoCalls.length > 0 ? nonTodoCalls : toolCalls), [nonTodoCalls, toolCalls]);

  if (!toolCalls || toolCalls.length === 0) return null;

  return (
    <div className="my-2 text-xs select-none">
      {/* 1. 单行聚合摘要胶囊 */}
      <button
        type="button"
        onClick={handleToggle}
        className="inline-flex items-center gap-2 py-1.5 px-2.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] text-[#9E9EA4] hover:text-[#ECECED] transition-colors cursor-pointer group"
        title={isOpen ? "收起操作步骤" : "展开查看详细操作步骤"}
      >
        <span className="flex items-center gap-1.5 font-medium text-zinc-300">
          {!isAllDone ? (
            <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
          ) : hasError ? (
            <X className="w-3.5 h-3.5 text-rose-400 shrink-0" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400/90 shrink-0" />
          )}
          <span>{actionSummary}</span>
        </span>

        {totalDuration > 0 && (
          <span className="text-[11px] font-mono text-zinc-500">
            {formatDuration(totalDuration)}
          </span>
        )}

        <ChevronDown
          className={`w-3.5 h-3.5 text-zinc-500 group-hover:text-zinc-300 transition-transform duration-200 ${
            !isOpen ? "-rotate-90" : ""
          }`}
        />
      </button>

      {/* 2. 展开态：垂直时间线节点列表（支持重复合并徽章与最大高度限制防止刷爆视口） */}
      {isOpen && (
        <div className="mt-1.5 ml-1 pl-2.5 border-l border-white/[0.08] space-y-0.5 max-h-80 overflow-y-auto scrollbar-thin animate-in fade-in slide-in-from-top-1 duration-150">
          {groupedCalls.map(({ toolCall, repeatCount }) => (
            <div key={toolCall.id} className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <ActionTimelineEntry
                  toolCall={toolCall}
                  isStreaming={isStreaming}
                  sessionId={sessionId}
                />
              </div>
              {repeatCount > 1 && (
                <span
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-white/[0.05] text-[10px] font-mono text-zinc-400 shrink-0"
                  title={`该操作连续执行了 ${repeatCount} 次`}
                >
                  <Layers className="w-2.5 h-2.5" />×{repeatCount}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
