"use client";

import React from "react";
import {
  Eye,
  FilePlus,
  FileCode,
  ListTree,
  Terminal,
  Search,
  Bot,
  Loader2,
  ChevronRight,
} from "lucide-react";
import { ToolCallItem } from "@/types";
import { useWorkbenchStore, inferAgentDisplayName } from "@/stores/useWorkbenchStore";
import { InlineSubAgentCard } from "./InlineSubAgentCard";

interface ActionTimelineEntryProps {
  toolCall: ToolCallItem;
  isStreaming?: boolean;
  sessionId?: string;
}

function getActionMeta(name: string, args?: Record<string, unknown>) {
  if (name.includes("read_file")) {
    const p = (args?.path as string) || "";
    return { icon: Eye, label: `已读取 ${p || "文件"}`, category: "read" };
  }
  if (name.includes("write_file") || name.includes("create_file")) {
    const p = (args?.path as string) || "";
    return { icon: FilePlus, label: `已创建 ${p || "文件"}`, category: "write" };
  }
  if (name.includes("edit_file")) {
    const p = (args?.path as string) || "";
    return { icon: FileCode, label: `已编辑 ${p || "文件"}`, category: "write" };
  }
  if (name.includes("list_dir")) {
    const p = (args?.path as string) || "";
    return { icon: ListTree, label: `已列出 ${p || "目录"} 中的文件`, category: "read" };
  }
  if (name.includes("execute_command") || name.includes("exec_command")) {
    const cmd = String(args?.command || args?.cmd || "").trim();
    const short = cmd.length > 45 ? cmd.slice(0, 45) + "..." : cmd;
    return { icon: Terminal, label: `已运行 ${short || "终端命令"}`, category: "exec" };
  }
  if (name.includes("grep_search")) {
    const q = (args?.query as string) || "";
    return { icon: Search, label: `已检索 "${q}"`, category: "read" };
  }
  if (name.includes("find_by_name")) {
    const pat = (args?.pattern as string) || "";
    return { icon: Search, label: `已查找文件 "${pat}"`, category: "read" };
  }
  if (name.includes("dispatch_subagent") || name.includes("spawn_agent")) {
    const t = (args?.mode as string) || (args?.agent_type as string) || "explore";
    const prompt = (args?.task as string) || (args?.task_prompt as string) || "";
    const displayName = inferAgentDisplayName(t, prompt);
    return { icon: Bot, label: `已调度: ${displayName}`, category: "subagent" };
  }
  if (name.includes("todo_write")) {
    const todos = Array.isArray(args?.todos) ? args.todos : [];
    return { icon: ListTree, label: `已更新任务清单 (${todos.length} 项)`, category: "todo" };
  }
  return { icon: Terminal, label: name, category: "other" };
}

function parseDiffStats(output: unknown): { additions: number; deletions: number } | null {
  if (!output) return null;
  let obj: unknown = output;
  if (typeof obj === "string") {
    try { obj = JSON.parse(obj); } catch { return null; }
  }
  if (typeof obj === "object" && obj !== null) {
    const rec = obj as Record<string, unknown>;
    const a = typeof rec.additions === "number" ? rec.additions : 0;
    const d = typeof rec.deletions === "number" ? rec.deletions : 0;
    if (a > 0 || d > 0) return { additions: a, deletions: d };
  }
  return null;
}

export function ActionTimelineEntry({ toolCall, isStreaming, sessionId }: ActionTimelineEntryProps) {
  const [isDetailOpen, setIsDetailOpen] = React.useState(false);
  const meta = getActionMeta(toolCall.name, toolCall.args);
  const isSubagent = meta?.category === "subagent";

  // 子代理委派原语直接渲染对话框内联可折叠子代理卡片（含 Steer / Stop / 右侧栏联动）
  if (isSubagent) {
    return (
      <InlineSubAgentCard
        toolCall={toolCall}
        isStreaming={isStreaming}
        sessionId={sessionId}
      />
    );
  }

  // todo_write returns null — skip rendering
  if (!meta) return null;

  const Icon = meta.icon;

  // 状态精准解析：非流式状态下绝不死循环 loading
  let status: "running" | "success" | "failed" = "success";
  if (toolCall.status === "failed") {
    status = "failed";
  } else if (toolCall.status === "success" || toolCall.output !== undefined) {
    status = "success";
  } else if (toolCall.status === "running") {
    status = isStreaming ? "running" : "success";
  } else {
    status = isStreaming ? "running" : "success";
  }

  const displayLabel = meta.label;
  const diffStats = parseDiffStats(toolCall.output);
  const isFileAction = meta.category === "write";

  const handleClick = () => {
    if (isFileAction && toolCall.output) {
      let obj: unknown = toolCall.output;
      if (typeof obj === "string") {
        try {
          obj = JSON.parse(obj);
        } catch {
          obj = null;
        }
      }
      const rec =
        typeof obj === "object" && obj !== null
          ? (obj as Record<string, unknown>)
          : null;
      const path =
        (typeof rec?.path === "string" && rec.path) ||
        (toolCall.args?.path as string);
      if (path) {
        const patchId =
          (typeof rec?.patch_id === "string" && rec.patch_id) ||
          (typeof rec?.snapshot_id === "string" && rec.snapshot_id) ||
          undefined;
        const wb = useWorkbenchStore.getState();
        wb.openChangesTab(
          {
            diffFiles: [
              {
                path,
                name: path.split("/").pop() || "file",
                additions: diffStats?.additions || 0,
                deletions: diffStats?.deletions || 0,
                originalContent:
                  typeof rec?.original_content === "string"
                    ? rec.original_content
                    : "",
                modifiedContent:
                  (typeof rec?.modified_content === "string" &&
                    rec.modified_content) ||
                  (toolCall.args?.content as string) ||
                  "",
                unifiedDiff:
                  (typeof rec?.diff === "string" && rec.diff) ||
                  (typeof rec?.unified_diff === "string" && rec.unified_diff) ||
                  "",
                ...(patchId ? { patchId, patch_id: patchId } : {}),
              },
            ],
            selectedFilePath: path,
          },
          true,
          sessionId
        );
        return;
      }
    }
    setIsDetailOpen(!isDetailOpen);
  };

  const outputString = toolCall.output
    ? typeof toolCall.output === "object"
      ? JSON.stringify(toolCall.output, null, 2)
      : String(toolCall.output)
    : null;

  return (
    <div className="group select-none">
      <div
        onClick={handleClick}
        className={`flex items-center gap-2 py-1 px-1 rounded-md transition-colors text-xs ${
          isFileAction || outputString
            ? "cursor-pointer hover:bg-white/[0.04]"
            : "cursor-default"
        }`}
      >
        {/* Status */}
        {status === "running" ? (
          <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
        ) : status === "failed" ? (
          <Icon className="w-3.5 h-3.5 text-red-400 shrink-0" />
        ) : (
          <Icon className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        )}

        {/* Label */}
        <span className="text-zinc-300 truncate flex-1 font-mono text-[12px]">
          {displayLabel}
        </span>

        {/* Diff stats badge */}
        {diffStats && (
          <div className="flex items-center gap-1 font-mono text-[10px] shrink-0">
            {diffStats.additions > 0 && (
              <span className="text-emerald-400 font-semibold">+{diffStats.additions}</span>
            )}
            {diffStats.deletions > 0 && (
              <span className="text-rose-400 font-semibold">-{diffStats.deletions}</span>
            )}
          </div>
        )}

        {/* Unsaved indicator for file actions */}
        {isFileAction && (
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
        )}

        {/* Expand arrow */}
        {(isFileAction || outputString) && (
          <ChevronRight
            className={`w-3 h-3 text-zinc-600 transition-transform shrink-0 ${
              isDetailOpen ? "rotate-90 text-zinc-400" : "opacity-0 group-hover:opacity-100"
            }`}
          />
        )}

        {/* Latency */}
        {toolCall.latency_ms && (
          <span className="text-[10px] text-zinc-600 font-mono shrink-0">
            {toolCall.latency_ms > 1000
              ? `${(toolCall.latency_ms / 1000).toFixed(1)}s`
              : `${toolCall.latency_ms}ms`}
          </span>
        )}
      </div>

      {/* Expanded detail output */}
      {isDetailOpen && outputString && !isFileAction && (
        <div className="ml-5 my-1 p-2 rounded bg-black/40 border border-white/[0.06] text-[11px] font-mono text-zinc-400 max-h-48 overflow-y-auto select-text scrollbar-thin">
          <pre className="whitespace-pre-wrap">{outputString}</pre>
        </div>
      )}
    </div>
  );
}
