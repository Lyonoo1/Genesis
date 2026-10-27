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
  CheckCircle2,
  Loader2,
  ChevronRight,
} from "lucide-react";
import { ToolCallItem } from "@/types";
import { useWorkbenchStore, inferAgentDisplayName } from "@/stores/useWorkbenchStore";

interface ActionTimelineEntryProps {
  toolCall: ToolCallItem;
  isStreaming?: boolean;
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
  if (name.includes("execute_command")) {
    const cmd = String(args?.command || "").trim();
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
  if (name.includes("dispatch_subagent")) {
    const t = (args?.agent_type as string) || "explore";
    const prompt = (args?.task_prompt as string) || "";
    const displayName = inferAgentDisplayName(t, prompt);
    return { icon: Bot, label: `已调度: ${displayName}`, category: "subagent" };
  }
  if (name.includes("todo_write")) {
    const todos = (args?.todos as any[]) || [];
    return { icon: ListTree, label: `已更新任务清单 (${todos.length} 项)`, category: "todo" };
  }
  return { icon: Terminal, label: name, category: "other" };
}

function parseDiffStats(output: unknown): { additions: number; deletions: number } | null {
  if (!output) return null;
  let obj: any = output;
  if (typeof obj === "string") {
    try { obj = JSON.parse(obj); } catch { return null; }
  }
  if (typeof obj === "object" && obj !== null) {
    const a = typeof obj.additions === "number" ? obj.additions : 0;
    const d = typeof obj.deletions === "number" ? obj.deletions : 0;
    if (a > 0 || d > 0) return { additions: a, deletions: d };
  }
  return null;
}

export function ActionTimelineEntry({ toolCall, isStreaming }: ActionTimelineEntryProps) {
  const [isDetailOpen, setIsDetailOpen] = React.useState(false);
  const meta = getActionMeta(toolCall.name, toolCall.args);

  // todo_write returns null — skip rendering
  if (!meta) return null;

  const Icon = meta.icon;
  const isSubagent = meta.category === "subagent";
  const rawId = toolCall.id || "";
  const agentId = rawId ? (rawId.startsWith("agent-") ? rawId : `agent-${rawId}`) : "";

  // 联动 workbench 中记录的子代理实例（获取其实时状态与具体专业称号）
  const subagentInstance = useWorkbenchStore((s) => {
    if (!isSubagent) return null;
    const currentSessionTabs = (s.activeSessionId && s.workbenchBySession[s.activeSessionId]?.tabs) || s.tabs || [];
    const panel = currentSessionTabs.find((t) => t.kind === "subagent-panel") as any;
    return panel?.agents?.find((a: any) => a.id === agentId || a.id === rawId) || null;
  });

  // 状态精准解析：子代理优先以其实际执行状态为准；流式中止或非流式状态下彻底杜绝死循环 loading
  let status: "running" | "success" | "failed" = "success";
  if (isSubagent && subagentInstance) {
    if (subagentInstance.status === "completed") {
      status = "success";
    } else if (subagentInstance.status === "failed") {
      status = "failed";
    } else if (subagentInstance.status === "running") {
      status = isStreaming ? "running" : "failed";
    }
  } else if (toolCall.status === "failed") {
    status = "failed";
  } else if (toolCall.status === "success" || toolCall.output !== undefined) {
    status = "success";
  } else if (toolCall.status === "running") {
    status = isStreaming ? "running" : "success";
  } else {
    status = isStreaming ? "running" : "success";
  }

  // 名称解析：避免缺少 args 时全部回退为“代码库探索者”
  let displayLabel = meta.label;
  if (isSubagent) {
    if (subagentInstance?.displayName) {
      displayLabel = `已调度: ${subagentInstance.displayName}`;
    } else {
      const prompt = (toolCall.args?.task_prompt as string) || subagentInstance?.taskPrompt || "";
      const t = (toolCall.args?.agent_type as string) || subagentInstance?.agentType || "explore";
      displayLabel = `已调度: ${inferAgentDisplayName(t, prompt)}`;
    }
  }

  const diffStats = parseDiffStats(toolCall.output);
  const isFileAction = meta.category === "write";

  const handleClick = () => {
    if (isFileAction && toolCall.output) {
      // Open changes tab
      let obj: any = toolCall.output;
      if (typeof obj === "string") try { obj = JSON.parse(obj); } catch {}
      const path = obj?.path || (toolCall.args?.path as string);
      if (path) {
        const wb = useWorkbenchStore.getState();
        wb.openChangesTab({
          diffFiles: [{
            path,
            name: path.split("/").pop() || "file",
            additions: diffStats?.additions || 0,
            deletions: diffStats?.deletions || 0,
            originalContent: obj?.original_content || "",
            modifiedContent: obj?.modified_content || (toolCall.args?.content as string) || "",
            unifiedDiff: obj?.diff || obj?.unified_diff || "",
          }],
          selectedFilePath: path,
        }, true);
        return;
      }
    }
    if (meta.category === "subagent") {
      const wb = useWorkbenchStore.getState();
      const rawId = toolCall.id || "";
      const agentId = rawId ? (rawId.startsWith("agent-") ? rawId : `agent-${rawId}`) : null;

      // 无论 subagent-panel tab 是否已被用户关闭，均自动重新打开并恢复该会话的历史子代理数据
      const panelTabId = wb.openSubagentPanel();
      if (panelTabId) {
        wb.setActiveTabId(panelTabId);
        if (agentId) {
          // 兜底保障：若该 agent 尚未在列表中，自动从 toolCall 参数与输出补全
          const updatedTabs = useWorkbenchStore.getState().tabs;
          const currentPanel = updatedTabs.find((t) => t.id === panelTabId) as any;
          if (currentPanel && !currentPanel.agents?.some((a: any) => a.id === agentId)) {
            const agentType = (toolCall.args?.agent_type === "verify" ? "verify" : "explore") as "explore" | "verify";
            const taskPrompt = (toolCall.args?.task_prompt as string) || "";
            wb.addAgentInstance(agentId, agentType, taskPrompt);

            if (toolCall.output) {
              let outObj: any = toolCall.output;
              if (typeof outObj === "string") {
                try {
                  outObj = JSON.parse(outObj);
                } catch {
                  outObj = { summary: toolCall.output };
                }
              }
              wb.updateAgentInstance(agentId, {
                status: toolCall.status === "failed" ? "failed" : "completed",
                summary:
                  outObj?.summary ||
                  outObj?.result ||
                  (typeof toolCall.output === "string" ? toolCall.output : undefined),
              });
            }
          }
          wb.setActiveAgent(agentId);
        }
      }
      const { useUIStore } = require("@/stores/useUIStore");
      useUIStore.getState().openRightSidebar();
      return;
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
          isFileAction || meta.category === "subagent" || outputString
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
        {(isFileAction || meta.category === "subagent" || outputString) && (
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
