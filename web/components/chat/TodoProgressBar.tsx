"use client";

import React, { useState } from "react";
import { ChevronDown, CheckCircle2, Circle, Loader2 } from "lucide-react";
import { useTodoStore, TodoItem } from "@/stores/useTodoStore";
import { useChatStore } from "@/stores/useChatStore";

interface TodoProgressBarProps {
  sessionId: string;
}

function StatusIcon({ status, isStreaming }: { status: TodoItem["status"]; isStreaming: boolean }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    case "in_progress":
      return isStreaming ? (
        <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
      ) : (
        <Circle className="w-3.5 h-3.5 text-blue-400 shrink-0" />
      );
    default:
      return <Circle className="w-3.5 h-3.5 text-zinc-500 shrink-0" />;
  }
}

export function TodoProgressBar({ sessionId }: TodoProgressBarProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const todos = useTodoStore((s) => s.todosBySession[sessionId]);
  const isStreaming = useChatStore((s) => s.isStreaming);

  if (!todos || todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.some((t) => t.status === "in_progress");
  const pct = Math.round((completed / todos.length) * 100);
  const allDone = completed === todos.length;

  // 核心决策：任务全部完成或当前对话停止/非流式运行状态下，自动隐藏吸顶进度条，释放对话视口
  if (allDone || !isStreaming) return null;

  return (
    <div className="sticky top-0 z-20 mx-auto w-full max-w-3xl mb-3 select-none">
      <div className="rounded-lg border border-hairline bg-[#1A1A1E]/95 backdrop-blur-sm shadow-sm overflow-hidden">
        {/* 折叠态：进度条头部 */}
        <div
          onClick={() => setIsExpanded(!isExpanded)}
          className="h-9 px-3 flex items-center gap-2.5 cursor-pointer hover:bg-white/[0.03] transition-colors"
        >
          {/* 状态图标 */}
          {allDone ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          ) : inProgress && isStreaming ? (
            <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
          ) : inProgress ? (
            <Circle className="w-3.5 h-3.5 text-blue-400 shrink-0" />
          ) : (
            <Circle className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
          )}

          <span className="text-xs text-zinc-300 font-medium shrink-0">
            任务进度
          </span>

          <span className="text-xs text-zinc-500 font-mono shrink-0">
            {completed}/{todos.length}
          </span>

          {/* 进度条 */}
          <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden mx-1">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                allDone ? "bg-emerald-500" : "bg-blue-500"
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>

          <span className="text-[11px] text-zinc-500 font-mono shrink-0">
            {pct}%
          </span>

          <ChevronDown
            className={`w-3.5 h-3.5 text-zinc-500 transition-transform duration-200 shrink-0 ${
              isExpanded ? "rotate-180" : ""
            }`}
          />
        </div>

        {/* 展开态：任务列表 */}
        {isExpanded && (
          <div className="border-t border-hairline px-3 py-2 space-y-1 max-h-[200px] overflow-y-auto scrollbar-thin animate-in fade-in slide-in-from-top-1 duration-150">
            {todos.map((todo) => (
              <div
                key={todo.id}
                className="flex items-start gap-2 py-1 text-xs"
              >
                <StatusIcon status={todo.status} isStreaming={isStreaming} />
                <span
                  className={`leading-snug ${
                    todo.status === "completed"
                      ? "text-zinc-500 line-through"
                      : todo.status === "in_progress"
                      ? "text-blue-300"
                      : "text-zinc-300"
                  }`}
                >
                  {todo.content}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
