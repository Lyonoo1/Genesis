"use client";

import React, { useState, useMemo } from "react";
import { ChevronDown, ChevronRight, Loader2, Check, X, FileEdit } from "lucide-react";
import { ToolCallItem } from "@/types";
import { ActionTimelineEntry } from "./ActionTimelineEntry";

interface ActionTimelineProps {
  toolCalls: ToolCallItem[];
  isStreaming?: boolean;
  durationMs?: number;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${Math.max(0.1, totalSeconds).toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

// 提炼动作类别摘要（对标 Codex 截图：“编辑了文件读取文件运行了命令”）
function extractActionSummary(toolCalls: ToolCallItem[]): string {
  const categories = new Set<string>();

  for (const tc of toolCalls) {
    const name = tc.name || "";
    if (name.includes("write_file") || name.includes("create_file") || name.includes("edit_file")) {
      categories.add("编辑了文件");
    } else if (name.includes("read_file") || name.includes("list_dir") || name.includes("grep") || name.includes("find")) {
      categories.add("读取文件");
    } else if (name.includes("execute_command")) {
      categories.add("运行了命令");
    } else if (name.includes("dispatch_subagent")) {
      categories.add("调度了协作代理");
    } else if (name.includes("todo_write")) {
      categories.add("规划了任务");
    }
  }

  if (categories.size === 0) {
    return `${toolCalls.length} 项操作`;
  }

  return Array.from(categories).join(" ");
}

export function ActionTimeline({
  toolCalls,
  isStreaming = false,
  durationMs,
}: ActionTimelineProps) {
  // 如果全是 todo_write，且已在顶栏展示，避免在聊天流内冗余占用空间，仅保持紧凑
  const nonTodoCalls = useMemo(
    () => toolCalls.filter((tc) => !tc.name.includes("todo_write")),
    [toolCalls]
  );

  // 如果没有其他调用只有 todo_write，我们展示一条合并的简洁摘要
  const callsToRender = nonTodoCalls.length > 0 ? nonTodoCalls : toolCalls.slice(0, 1);

  const finishedCount = toolCalls.filter(
    (t) => t.output !== undefined || t.status === "success" || t.status === "failed"
  ).length;
  const isAllDone = !isStreaming || finishedCount >= toolCalls.length;
  const hasError = toolCalls.some((t) => t.status === "failed");

  // 默认展开以符合 Codex 体验，用户可点击折叠
  const [isOpen, setIsOpen] = useState(true);

  // 计算总耗时
  const totalDuration = useMemo(() => {
    if (durationMs) return durationMs / 1000;
    const sumMs = toolCalls.reduce((acc, cur) => acc + (cur.latency_ms || 0), 0);
    return sumMs > 0 ? sumMs / 1000 : 0;
  }, [toolCalls, durationMs]);

  const actionSummary = useMemo(() => extractActionSummary(toolCalls), [toolCalls]);

  if (!toolCalls || toolCalls.length === 0) return null;

  return (
    <div className="my-2 text-xs select-none">
      {/* 1. 动作汇总标题行 (对标 Codex: ✏️ 编辑了文件读取文件运行了命令 ⌵) */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center gap-2 py-1 px-1.5 rounded hover:bg-white/[0.04] text-[#8E8E93] hover:text-[#ECECED] transition-colors cursor-pointer group"
        title={isOpen ? "收起操作记录" : "展开操作记录"}
      >
        <span className="flex items-center gap-1.5 font-medium text-zinc-300">
          {!isAllDone ? (
            <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
          ) : hasError ? (
            <X className="w-3.5 h-3.5 text-rose-400 shrink-0" />
          ) : (
            <FileEdit className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
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
      </div>

      {/* 2. 展开态：垂直时间线节点列表 */}
      {isOpen && (
        <div className="mt-1 ml-1 pl-2 border-l border-white/[0.08] space-y-0.5 animate-in fade-in slide-in-from-top-1 duration-150">
          {callsToRender.map((tc) => (
            <ActionTimelineEntry
              key={tc.id}
              toolCall={tc}
              isStreaming={isStreaming}
            />
          ))}
        </div>
      )}
    </div>
  );
}
