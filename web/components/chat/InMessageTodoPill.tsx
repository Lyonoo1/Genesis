"use client";

import React, { useState, useMemo } from "react";
import { CheckCircle2, Circle, Loader2, ChevronDown } from "lucide-react";
import { ToolCallItem } from "@/types";
import { useChatStore } from "@/stores/useChatStore";

interface InMessageTodoPillProps {
  toolCall: ToolCallItem;
}

interface ParsedTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export function InMessageTodoPill({ toolCall }: InMessageTodoPillProps) {
  const [isOpen, setIsOpen] = useState(false);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const todos = useMemo<ParsedTodo[]>(() => {
    let raw: any = toolCall.args?.todos || toolCall.args?.tasks || toolCall.args?.items || [];
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw); } catch { raw = []; }
    }
    if (!Array.isArray(raw)) return [];

    return raw.map((item: any, idx: number) => {
      if (typeof item === "string") {
        return { id: `todo-${idx}`, content: item, status: "pending" as const };
      }
      return {
        id: String(item.id || `todo-${idx}`),
        content: String(item.content || item.title || item.task || ""),
        status: (item.status === "completed"
          ? "completed"
          : item.status === "in_progress"
          ? "in_progress"
          : "pending") as "pending" | "in_progress" | "completed",
      };
    });
  }, [toolCall.args]);

  if (todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.some((t) => t.status === "in_progress");
  const allDone = completed === todos.length;
  const isActivelyRunning = inProgress && isStreaming && toolCall.status === "running";

  return (
    <div className="my-2 select-none">
      {/* 极简胶囊行 (28px 高度，无吸顶，与对话内容自然融合) */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center gap-2 h-7 px-2.5 rounded-lg bg-[#18181B] hover:bg-[#202024] border border-white/[0.08] text-xs text-zinc-300 cursor-pointer transition-all shadow-sm group"
        title={isOpen ? "收起任务清单" : "展开任务清单"}
      >
        {allDone ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
        ) : isActivelyRunning ? (
          <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
        ) : inProgress ? (
          <Circle className="w-3.5 h-3.5 text-blue-400 shrink-0" />
        ) : (
          <Circle className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        )}

        <span className="font-medium text-zinc-200">
          {allDone
            ? "计划任务已全部完成"
            : isActivelyRunning
            ? "计划任务执行中"
            : "计划任务清单"}
        </span>

        <span className="font-mono text-[11px] text-zinc-400">
          ({completed}/{todos.length})
        </span>

        <ChevronDown
          className={`w-3 h-3 text-zinc-500 group-hover:text-zinc-300 transition-transform duration-200 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </div>

      {/* 展开态：紧凑任务清单 */}
      {isOpen && (
        <div className="mt-1.5 p-2 rounded-lg bg-[#141416] border border-white/[0.06] space-y-1 max-w-md animate-in fade-in slide-in-from-top-1 duration-150">
          {todos.map((todo) => (
            <div key={todo.id} className="flex items-start gap-2 py-0.5 text-xs">
              {todo.status === "completed" ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
              ) : todo.status === "in_progress" && isActivelyRunning ? (
                <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0 mt-0.5" />
              ) : todo.status === "in_progress" ? (
                <Circle className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
              ) : (
                <Circle className="w-3.5 h-3.5 text-zinc-500 shrink-0 mt-0.5" />
              )}
              <span
                className={`leading-snug ${
                  todo.status === "completed"
                    ? "text-zinc-500 line-through"
                    : todo.status === "in_progress"
                    ? "text-blue-300 font-medium"
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
  );
}
