"use client";

import React, { useState, useMemo } from "react";
import {
  ChevronRight,
  Terminal,
  Check,
  X,
  Loader2,
  Copy,
  FileCode,
  AlertTriangle,
  GitCompare,
  Square,
  Globe,
  ExternalLink,
  Activity,
} from "lucide-react";
import { stopProcessApi } from "@/lib/api/chat";
import { useWorkbenchStore } from "@/stores/useWorkbenchStore";

interface ToolCallAccordionProps {
  toolCall: {
    id: string;
    name: string;
    args?: Record<string, unknown>;
    status?: "running" | "success" | "failed";
  };
  toolResult?: {
    output?: unknown;
    error?: string;
    latencyMs?: number;
  };
  isStreaming?: boolean;
}

interface DiffLineItem {
  line: string;
  type: "header" | "hunk" | "add" | "delete" | "context";
  key: number;
}

// 友好可读标题格式化
function getToolDisplayName(name: string, args?: Record<string, unknown>) {
  if (name.includes("read_file")) {
    const p = (args?.path as string) || "";
    return p ? `读取: ${p}` : "读取文件";
  }
  if (name.includes("write_file") || name.includes("create_file")) {
    const p = (args?.path as string) || "";
    return p ? `写入: ${p}` : "写入文件";
  }
  if (name.includes("edit_file")) {
    const p = (args?.path as string) || "";
    return p ? `编辑: ${p}` : "编辑文件";
  }
  if (name.includes("delete_file")) {
    const p = (args?.path as string) || "";
    return p ? `删除: ${p}` : "删除文件";
  }
  if (name.includes("list_dir")) {
    const p = (args?.path as string) || "";
    return p ? `列出: ${p}` : "列出目录";
  }
  if (name.includes("execute_command")) {
    const cmd = String(args?.command || "").trim();
    return cmd ? `执行: ${cmd.length > 35 ? cmd.slice(0, 35) + "..." : cmd}` : "终端命令";
  }
  if (name.includes("grep_search")) {
    const q = (args?.query as string) || "";
    return q ? `检索: ${q}` : "全文检索";
  }
  if (name.includes("find_by_name")) {
    const pat = (args?.pattern as string) || "";
    return pat ? `查找: ${pat}` : "文件查找";
  }
  if (name.includes("stop_process")) {
    const pid = args?.pid;
    return pid ? `终止进程: PID ${pid}` : "终止后台进程";
  }
  return name;
}

export function ToolCallAccordion({
  toolCall,
  toolResult,
  isStreaming = false,
}: ToolCallAccordionProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const [isStopped, setIsStopped] = useState(false);
  const [isStopping, setIsStopping] = useState(false);

  // 状态推导：优先使用显式状态；未推流状态下绝不展示 running 转圈
  const status: "running" | "success" | "failed" = toolCall.status
    ? toolCall.status
    : toolResult?.error
    ? "failed"
    : toolResult?.output !== undefined
    ? "success"
    : isStreaming
    ? "running"
    : "success";

  const latency = toolResult?.latencyMs ? `${toolResult.latencyMs}ms` : null;

  // 解析结构化返回值中的 Unified Diff、增删行数与自愈信息
  const outputData = useMemo(() => {
    if (!toolResult?.output) return null;
    let obj: any = toolResult.output;
    if (typeof obj === "string") {
      const trimmed = obj.trim();
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
          obj = JSON.parse(trimmed);
        } catch {
          return null;
        }
      } else {
        return null;
      }
    }
    if (typeof obj === "object" && obj !== null) {
      return {
        diff: typeof obj.diff === "string" && obj.diff.trim().length > 0 ? obj.diff : null,
        additions: typeof obj.additions === "number" ? obj.additions : null,
        deletions: typeof obj.deletions === "number" ? obj.deletions : null,
        path: typeof obj.path === "string" ? obj.path : null,
        tierMessage: typeof obj.tier_message === "string" ? obj.tier_message : null,
        syntaxWarning: typeof obj.syntax_warning === "string" ? obj.syntax_warning : null,
        message: typeof obj.message === "string" ? obj.message : null,
        isBackground: obj.status === "running_in_background",
        pid: typeof obj.pid === "number" ? obj.pid : null,
        url: typeof obj.url === "string" ? obj.url : null,
        command: typeof obj.command === "string" ? obj.command : null,
        recentLogs: Array.isArray(obj.recent_logs) ? obj.recent_logs : null,
      };
    }
    return null;
  }, [toolResult?.output]);

  const handleStopProcess = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!outputData?.pid || isStopped || isStopping) return;
    setIsStopping(true);
    try {
      await stopProcessApi(outputData.pid);
      setIsStopped(true);
    } catch (err) {
      console.error("Failed to stop process:", err);
    } finally {
      setIsStopping(false);
    }
  };

  // 解析 Unified Diff 文本行
  const diffLines = useMemo<DiffLineItem[]>(() => {
    if (!outputData?.diff) return [];
    return outputData.diff.split("\n").map((line: string, idx: number): DiffLineItem => {
      let type: "header" | "hunk" | "add" | "delete" | "context" = "context";
      if (line.startsWith("---") || line.startsWith("+++")) {
        type = "header";
      } else if (line.startsWith("@@")) {
        type = "hunk";
      } else if (line.startsWith("+")) {
        type = "add";
      } else if (line.startsWith("-")) {
        type = "delete";
      }
      return { line, type, key: idx };
    });
  }, [outputData?.diff]);

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

  const hasDiff = Boolean(outputData?.diff);

  return (
    <div className="my-1.5 rounded-lg border border-hairline bg-[#18181C] overflow-hidden transition-all duration-150 shadow-sm select-none">
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
          <div className="font-mono text-xs truncate flex items-center gap-1.5 min-w-0">
            <span className="text-codex-muted font-normal shrink-0">调用:</span>
            <span className="font-medium text-white truncate" title={toolCall.name}>
              {getToolDisplayName(toolCall.name, toolCall.args)}
            </span>
          </div>

          {/* 增删行数快速徽章 */}
          {hasDiff && (outputData?.additions !== null || outputData?.deletions !== null) && (
            <div className="flex items-center gap-1 font-mono text-[10px] ml-1 shrink-0">
              {(outputData?.additions ?? 0) > 0 && (
                <span className="text-emerald-400 font-semibold">+{outputData?.additions}</span>
              )}
              {(outputData?.deletions ?? 0) > 0 && (
                <span className="text-rose-400 font-semibold">-{outputData?.deletions}</span>
              )}
            </div>
          )}
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
          {/* 0. 后台守护服务状态与控制面板 */}
          {outputData?.isBackground && (
            <div className="p-3 rounded-lg bg-[#0F0F13] border border-hairline/80 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity
                    className={`w-4 h-4 ${
                      isStopped ? "text-zinc-500" : "text-emerald-400 animate-pulse"
                    }`}
                  />
                  <span className="font-semibold text-white text-xs">
                    {isStopped ? "后台进程已终止" : "后台守护进程实时运行中"}
                  </span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-white/[0.05] text-zinc-400">
                    PID: {outputData.pid}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {outputData.url && (
                    <button
                      type="button"
                      onClick={() =>
                        useWorkbenchStore
                          .getState()
                          .openNewBrowserTab(outputData.url!, outputData.url!)
                      }
                      className="flex items-center gap-1 px-2.5 py-1 rounded bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 border border-blue-500/25 text-xs font-medium transition-colors cursor-pointer"
                    >
                      <ExternalLink className="w-3 h-3" />
                      <span>在工作台浏览器打开</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={handleStopProcess}
                    disabled={isStopped || isStopping}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-all cursor-pointer ${
                      isStopped
                        ? "bg-zinc-800 text-zinc-500 cursor-not-allowed border border-white/5"
                        : "bg-red-600 hover:bg-red-500 text-white shadow-sm"
                    }`}
                  >
                    {isStopping ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : isStopped ? (
                      <Check className="w-3 h-3" />
                    ) : (
                      <Square className="w-3 h-3 fill-current" />
                    )}
                    <span>{isStopped ? "服务已终止" : "停止服务 (Kill Process)"}</span>
                  </button>
                </div>
              </div>

              {outputData.url && (
                <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-400 bg-black/40 px-2.5 py-1.5 rounded border border-white/5">
                  <Globe className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                  <span>服务监听地址:</span>
                  <a
                    href={outputData.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-400 hover:underline font-semibold"
                  >
                    {outputData.url}
                  </a>
                </div>
              )}
            </div>
          )}

          {/* A. 结构化 Unified Diff 差异对比区 */}
          {hasDiff && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-codex-muted uppercase tracking-wider font-semibold">
                <div className="flex items-center gap-1.5 min-w-0">
                  <GitCompare className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span className="text-white font-medium">Unified Diff</span>
                  {outputData?.path && (
                    <span className="text-zinc-400 truncate font-mono lowercase font-normal">
                      ({outputData.path})
                    </span>
                  )}
                  {outputData?.tierMessage && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono normal-case bg-blue-500/15 text-blue-300 border border-blue-500/25 ml-1">
                      {outputData.tierMessage}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-emerald-400 font-mono text-xs font-bold">
                    +{outputData?.additions ?? 0}
                  </span>
                  <span className="text-rose-400 font-mono text-xs font-bold">
                    -{outputData?.deletions ?? 0}
                  </span>
                </div>
              </div>

              {/* 差异代码行单列渲染 */}
              <div className="rounded-lg border border-hairline/80 bg-[#0B0B0E] overflow-hidden text-[12px] font-mono leading-relaxed">
                <div className="max-h-[300px] overflow-y-auto overflow-x-auto scrollbar-thin divide-y divide-white/[0.02]">
                  {diffLines.map(({ line, type, key }) => {
                    if (type === "header") {
                      return (
                        <div
                          key={key}
                          className="px-3 py-1 text-zinc-500 bg-white/[0.02] text-[11px] select-none font-mono"
                        >
                          {line}
                        </div>
                      );
                    }
                    if (type === "hunk") {
                      return (
                        <div
                          key={key}
                          className="px-3 py-1 text-sky-400 bg-sky-950/40 text-[11px] font-medium border-y border-sky-500/20 select-none font-mono"
                        >
                          {line}
                        </div>
                      );
                    }
                    if (type === "add") {
                      return (
                        <div
                          key={key}
                          className="px-3 py-0.5 bg-emerald-500/15 text-emerald-200 border-l-2 border-emerald-500 flex items-start"
                        >
                          <span className="select-none text-emerald-400 font-bold w-4 shrink-0">
                            +
                          </span>
                          <span className="flex-1 whitespace-pre">
                            {line.slice(1)}
                          </span>
                        </div>
                      );
                    }
                    if (type === "delete") {
                      return (
                        <div
                          key={key}
                          className="px-3 py-0.5 bg-rose-500/15 text-rose-200 border-l-2 border-rose-500 flex items-start"
                        >
                          <span className="select-none text-rose-400 font-bold w-4 shrink-0">
                            -
                          </span>
                          <span className="flex-1 whitespace-pre line-through opacity-80">
                            {line.slice(1)}
                          </span>
                        </div>
                      );
                    }
                    return (
                      <div
                        key={key}
                        className="px-3 py-0.5 text-zinc-300 flex items-start hover:bg-white/[0.02]"
                      >
                        <span className="select-none text-zinc-600 w-4 shrink-0">
                          {" "}
                        </span>
                        <span className="flex-1 whitespace-pre">
                          {line.startsWith(" ") ? line.slice(1) : line}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* B. AST 语法自愈警告 Callout */}
          {outputData?.syntaxWarning && (
            <div className="p-3 rounded-lg bg-amber-950/25 border border-amber-500/30 text-amber-200 space-y-1.5 animate-in fade-in">
              <div className="flex items-center gap-1.5 font-semibold text-xs text-amber-300">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>AST 语法自愈诊断警告</span>
              </div>
              <pre className="p-2.5 rounded bg-black/60 border border-amber-500/20 text-[11px] font-mono text-amber-100 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                <code>{outputData.syntaxWarning}</code>
              </pre>
            </div>
          )}

          {/* C. Parameters JSON */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-[11px] text-codex-muted uppercase tracking-wider font-semibold">
              <Terminal className="w-3 h-3 text-codex-muted" />
              <span>Parameters</span>
            </div>
            <pre className="p-2.5 rounded-lg bg-black/40 border border-hairline/60 overflow-x-auto text-[#ECECEE] text-[12px] leading-relaxed scrollbar-thin">
              <code>{JSON.stringify(toolCall.args || {}, null, 2)}</code>
            </pre>
          </div>

          {/* D. Execution Output (当无 diff 时展示或折叠展示原始返回值) */}
          {rawOutputString && !hasDiff && (
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
