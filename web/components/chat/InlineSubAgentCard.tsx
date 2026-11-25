"use client";

import React, { useState, useMemo, useEffect } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  Square,
  Send,
  PanelRightOpen,
  BrainCircuit,
  Lock,
  Terminal,
  Eye,
  FileSearch,
  ListTree,
  FileCode,
  Clock,
  Sparkles,
  Check,
  AlertCircle,
} from "lucide-react";
import { ToolCallItem } from "@/types";
import {
  useWorkbenchStore,
  SubagentInstance,
  SubagentMode,
  SubagentStatus,
  inferAgentDisplayName,
} from "@/stores/useWorkbenchStore";
import { useUIStore } from "@/stores/useUIStore";
import { steerSubagentApi, stopSubagentApi } from "@/lib/api/chat";

export interface InlineSubAgentCardProps {
  toolCall: ToolCallItem;
  sessionId?: string;
  isStreaming?: boolean;
  toolResultOutput?: unknown;
}

function normalizeMode(raw?: unknown): SubagentMode {
  const val = String(raw || "").toLowerCase();
  if (val === "code_worker") return "code_worker";
  if (val === "verify") return "verify";
  return "explore";
}

function getModeMeta(mode: SubagentMode) {
  switch (mode) {
    case "code_worker":
      return {
        label: "Code Worker",
        badgeClass:
          "bg-violet-500/15 text-violet-300 border-violet-500/30",
        dotClass: "bg-violet-400",
      };
    case "verify":
      return {
        label: "Verify",
        badgeClass:
          "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
        dotClass: "bg-emerald-400",
      };
    default:
      return {
        label: "Explore",
        badgeClass: "bg-sky-500/15 text-sky-300 border-sky-500/30",
        dotClass: "bg-sky-400",
      };
  }
}

function StepMiniIcon({ toolName }: { toolName: string }) {
  if (toolName.includes("read_file")) {
    return <Eye className="w-3 h-3 text-zinc-400 shrink-0" />;
  }
  if (toolName.includes("list_dir")) {
    return <ListTree className="w-3 h-3 text-zinc-400 shrink-0" />;
  }
  if (toolName.includes("grep") || toolName.includes("find")) {
    return <FileSearch className="w-3 h-3 text-zinc-400 shrink-0" />;
  }
  if (toolName.includes("write") || toolName.includes("edit") || toolName.includes("delete")) {
    return <FileCode className="w-3 h-3 text-violet-400 shrink-0" />;
  }
  return <Terminal className="w-3 h-3 text-zinc-400 shrink-0" />;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(100, Math.round(ms))}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const rem = Math.floor(sec % 60);
  return `${m}m ${rem}s`;
}

export function InlineSubAgentCard({
  toolCall,
  sessionId,
  isStreaming = false,
  toolResultOutput,
}: InlineSubAgentCardProps) {
  const effectiveSessionId = useWorkbenchStore(
    (s) => sessionId || s.activeSessionId || "default"
  );

  // 解析 toolCall 输出中携带的真实 agent_id / mode / write_scope / summary
  const parsedOutput = useMemo<Record<string, unknown> | null>(() => {
    const raw = toolResultOutput !== undefined ? toolResultOutput : toolCall.output;
    if (!raw) return null;
    if (typeof raw === "object" && raw !== null) {
      return raw as Record<string, unknown>;
    }
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return { summary: raw };
      }
    }
    return null;
  }, [toolCall.output, toolResultOutput]);

  const rawToolCallId = toolCall.id || "";
  const outputAgentId =
    typeof parsedOutput?.agent_id === "string" && parsedOutput.agent_id
      ? parsedOutput.agent_id
      : null;

  // 订阅右侧工作台中的实时子代理实例（通过 parentCallId / realAgentId 精准匹配）
  const subagentInstance = useWorkbenchStore((s): SubagentInstance | null => {
    const sessionTabs =
      (effectiveSessionId && s.workbenchBySession[effectiveSessionId]?.tabs) ||
      s.tabs ||
      [];
    const panel = sessionTabs.find((t) => t.kind === "subagent-panel") as
      | { agents?: SubagentInstance[] }
      | undefined;
    const pool =
      panel?.agents ||
      (effectiveSessionId
        ? s.workbenchBySession[effectiveSessionId]?.cachedSubagents
        : undefined) ||
      [];
    return (
      pool.find(
        (a) =>
          (outputAgentId && a.id === outputAgentId) ||
          (rawToolCallId && a.parentCallId === rawToolCallId) ||
          (rawToolCallId && a.id === rawToolCallId) ||
          (rawToolCallId && a.id === `agent-${rawToolCallId}`)
      ) || null
    );
  });

  const resolvedAgentId =
    subagentInstance?.id ||
    outputAgentId ||
    (toolCall.name.includes("dispatch_subagent")
      ? rawToolCallId.startsWith("agent-")
        ? rawToolCallId
        : `agent-${rawToolCallId}`
      : rawToolCallId || `subagent_${Date.now()}`);

  const mode: SubagentMode =
    subagentInstance?.agentType ||
    normalizeMode(
      toolCall.args?.mode || toolCall.args?.agent_type || parsedOutput?.mode
    );
  const modeMeta = getModeMeta(mode);

  const writeScope = useMemo<string[]>(() => {
    if (subagentInstance?.writeScope && subagentInstance.writeScope.length > 0) {
      return subagentInstance.writeScope;
    }
    const raw = toolCall.args?.write_scope || parsedOutput?.write_scope;
    if (Array.isArray(raw)) {
      return raw.map((item) => String(item)).filter(Boolean);
    }
    return [];
  }, [subagentInstance?.writeScope, toolCall.args?.write_scope, parsedOutput?.write_scope]);

  const taskPrompt =
    subagentInstance?.taskPrompt ||
    (typeof toolCall.args?.task === "string" ? toolCall.args.task : "") ||
    (typeof toolCall.args?.task_prompt === "string" ? toolCall.args.task_prompt : "") ||
    "自主委派子代理执行任务";

  const displayName =
    subagentInstance?.displayName ||
    inferAgentDisplayName(mode, taskPrompt, [], resolvedAgentId);

  // 状态推导：优先取工作台实时实例状态；非流式历史态不死锁转圈
  const status: SubagentStatus = useMemo(() => {
    if (subagentInstance) {
      if (subagentInstance.status === "terminated") return "terminated";
      if (subagentInstance.status === "completed") return "completed";
      if (subagentInstance.status === "failed") return "failed";
      if (subagentInstance.status === "running") {
        // spawn_agent 是非阻塞后台运行，即使 spawn 工具本身返回了 RUNNING，仍可能继续运行
        if (parsedOutput?.status === "RUNNING" || isStreaming) {
          return "running";
        }
        return "completed";
      }
    }
    if (toolCall.status === "failed" || parsedOutput?.success === false) {
      return "failed";
    }
    if (parsedOutput?.status === "TERMINATED") return "terminated";
    if (parsedOutput?.status === "RUNNING") {
      return isStreaming ? "running" : "completed";
    }
    if (toolCall.status === "success" || parsedOutput !== null) {
      return "completed";
    }
    return isStreaming ? "running" : "completed";
  }, [subagentInstance, toolCall.status, parsedOutput, isStreaming]);

  const [isExpanded, setIsExpanded] = useState<boolean>(status === "running");
  const [steerInput, setSteerInput] = useState("");
  const [isSteering, setIsSteering] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [feedbackBanner, setFeedbackBanner] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // 实时计时器
  const startMsRef = React.useRef<number>(
    subagentInstance?.startedAtMs || Date.now()
  );
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (subagentInstance?.startedAtMs) {
      startMsRef.current = subagentInstance.startedAtMs;
    }
  }, [subagentInstance?.startedAtMs]);

  useEffect(() => {
    if (status !== "running") return;
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 500);
    return () => clearInterval(timer);
  }, [status]);

  const elapsedMs = useMemo(() => {
    if (subagentInstance?.startedAtMs && subagentInstance?.endedAtMs) {
      return Math.max(100, subagentInstance.endedAtMs - subagentInstance.startedAtMs);
    }
    if (status === "running") {
      return Math.max(100, nowMs - startMsRef.current);
    }
    if (toolCall.latency_ms) return toolCall.latency_ms;
    return 0;
  }, [subagentInstance?.startedAtMs, subagentInstance?.endedAtMs, status, nowMs, toolCall.latency_ms]);

  const steps = subagentInstance?.steps || [];
  const currentStep = subagentInstance?.currentStep ?? steps.length;
  const maxSteps =
    subagentInstance?.maxSteps ||
    (typeof toolCall.args?.max_steps === "number" ? toolCall.args.max_steps : 8);
  const reasoning = subagentInstance?.thinkingContent || "";
  const summary =
    subagentInstance?.summary ||
    (typeof parsedOutput?.summary === "string" ? parsedOutput.summary : "") ||
    (typeof parsedOutput?.error === "string" ? parsedOutput.error : "");

  const showFeedback = (type: "success" | "error", text: string) => {
    setFeedbackBanner({ type, text });
    setTimeout(() => {
      setFeedbackBanner((prev) => (prev?.text === text ? null : prev));
    }, 3500);
  };

  // 单点纠偏 Steer
  const handleSteerSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const content = steerInput.trim();
    if (!content || isSteering || status !== "running") return;
    setIsSteering(true);
    try {
      const res = await steerSubagentApi(effectiveSessionId, resolvedAgentId, content, true);
      if (res?.success !== false) {
        setSteerInput("");
        showFeedback("success", "纠偏指令已实时注入子代理");
      } else {
        showFeedback("error", res?.message || "纠偏指令投递失败");
      }
    } catch (err) {
      showFeedback(
        "error",
        err instanceof Error ? err.message : "纠偏失败：子代理可能已结束"
      );
    } finally {
      setIsSteering(false);
    }
  };

  // 单点终止 Stop Subagent
  const handleStopSubagent = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isStopping || status !== "running") return;
    setIsStopping(true);
    try {
      await stopSubagentApi(effectiveSessionId, resolvedAgentId);
      useWorkbenchStore
        .getState()
        .markSubagentStopped(resolvedAgentId, effectiveSessionId);
      showFeedback("success", "已单点终止该子代理并释放写锁");
    } catch (err) {
      // 即使后端已自然退出，也同步收拢前端卡片状态
      useWorkbenchStore
        .getState()
        .markSubagentStopped(resolvedAgentId, effectiveSessionId);
      showFeedback(
        "error",
        err instanceof Error ? err.message : "已标记终止"
      );
    } finally {
      setIsStopping(false);
    }
  };

  // 右侧栏聚焦完整日志
  const handleFocusInWorkbench = (e: React.MouseEvent) => {
    e.stopPropagation();
    const wb = useWorkbenchStore.getState();
    const panelTabId = wb.openSubagentPanel(effectiveSessionId, true);
    if (panelTabId) {
      const updatedTabs =
        wb.workbenchBySession[effectiveSessionId]?.tabs || wb.tabs || [];
      const currentPanel = updatedTabs.find((t) => t.id === panelTabId) as
        | { agents?: SubagentInstance[] }
        | undefined;
      const exists = currentPanel?.agents?.some(
        (a) => a.id === resolvedAgentId || (rawToolCallId && a.parentCallId === rawToolCallId)
      );
      if (!exists) {
        wb.addAgentInstance(resolvedAgentId, mode, taskPrompt, effectiveSessionId, {
          parentCallId: rawToolCallId || undefined,
          writeScope: writeScope.length > 0 ? writeScope : undefined,
          maxSteps,
        });
        if (summary || status !== "running") {
          wb.updateAgentInstance(
            resolvedAgentId,
            {
              status,
              summary: summary || undefined,
            },
            effectiveSessionId
          );
        }
      }
      wb.setActiveAgent(resolvedAgentId, effectiveSessionId);
    }
    useUIStore.getState().openRightSidebar();
  };

  const statusMeta = useMemo(() => {
    switch (status) {
      case "running":
        return {
          text: "运行中",
          dot: "bg-sky-400 animate-pulse shadow-[0_0_8px_rgba(56,189,248,0.8)]",
          textClass: "text-sky-300",
          borderClass: "border-sky-500/25",
        };
      case "completed":
        return {
          text: "已完成",
          dot: "bg-emerald-400",
          textClass: "text-emerald-300",
          borderClass: "border-white/[0.08]",
        };
      case "terminated":
        return {
          text: "已中断",
          dot: "bg-amber-400",
          textClass: "text-amber-300",
          borderClass: "border-amber-500/25",
        };
      case "failed":
        return {
          text: "失败",
          dot: "bg-rose-400",
          textClass: "text-rose-300",
          borderClass: "border-rose-500/25",
        };
    }
  }, [status]);

  const shortAgentId =
    resolvedAgentId.length > 22
      ? `${resolvedAgentId.slice(0, 12)}…${resolvedAgentId.slice(-6)}`
      : resolvedAgentId;

  return (
    <div
      className={`my-2 rounded-xl border ${statusMeta.borderClass} bg-[#18181C] overflow-hidden shadow-sm transition-all duration-150 select-none`}
    >
      {/* 1. 头部状态栏 */}
      <div
        onClick={() => setIsExpanded((prev) => !prev)}
        className="px-3 py-2 flex items-center justify-between gap-2 cursor-pointer hover:bg-white/[0.03] transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
          {/* 状态呼吸灯 + 图标 */}
          <span className="relative flex items-center justify-center shrink-0">
            <span className={`w-2 h-2 rounded-full ${statusMeta.dot}`} />
          </span>

          {/* 模式徽章 */}
          <span
            className={`px-1.5 py-0.5 rounded-md text-[10px] font-semibold tracking-wide border shrink-0 ${modeMeta.badgeClass}`}
          >
            {modeMeta.label}
          </span>

          {/* 代理名称 */}
          <span className="text-xs font-medium text-white truncate max-w-[200px]">
            {displayName}
          </span>

          {/* agent_id 标签 */}
          <span
            className="px-1.5 py-0.5 rounded bg-black/40 border border-white/[0.06] font-mono text-[10px] text-zinc-400 shrink-0"
            title={resolvedAgentId}
          >
            {shortAgentId}
          </span>

          {/* write_scope 排他写锁标签 */}
          {writeScope.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {writeScope.slice(0, 2).map((scope) => (
                <span
                  key={scope}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-violet-950/40 border border-violet-500/25 font-mono text-[10px] text-violet-200 max-w-[160px] truncate"
                  title={`Write Scope: ${scope}`}
                >
                  <Lock className="w-2.5 h-2.5 text-violet-400 shrink-0" />
                  <span className="truncate">{scope}</span>
                </span>
              ))}
              {writeScope.length > 2 && (
                <span className="text-[10px] font-mono text-zinc-500">
                  +{writeScope.length - 2}
                </span>
              )}
            </div>
          )}
        </div>

        {/* 右侧：实时步数、耗时、状态文案、快捷联动与折叠箭头 */}
        <div className="flex items-center gap-2 shrink-0">
          {(currentStep > 0 || status === "running") && (
            <span className="font-mono text-[10px] text-zinc-400 bg-white/[0.04] px-1.5 py-0.5 rounded">
              Step {currentStep}/{maxSteps}
            </span>
          )}

          {elapsedMs > 0 && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-zinc-400">
              <Clock className="w-2.5 h-2.5 text-zinc-500" />
              {formatElapsed(elapsedMs)}
            </span>
          )}

          <span
            className={`inline-flex items-center gap-1 text-[11px] font-medium ${statusMeta.textClass}`}
          >
            {status === "running" ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : status === "completed" ? (
              <CheckCircle2 className="w-3 h-3" />
            ) : status === "terminated" ? (
              <Square className="w-2.5 h-2.5 fill-current" />
            ) : (
              <XCircle className="w-3 h-3" />
            )}
            <span className="hidden sm:inline">{statusMeta.text}</span>
          </span>

          <button
            type="button"
            onClick={handleFocusInWorkbench}
            className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
            title="在右侧栏协作代理面板中聚焦查看完整日志"
          >
            <PanelRightOpen className="w-3.5 h-3.5" />
          </button>

          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
          )}
        </div>
      </div>

      {/* 2. 可折叠实时内部流 */}
      {isExpanded && (
        <div className="border-t border-white/[0.06] bg-[#121215] px-3 py-2.5 space-y-2.5 text-xs select-text animate-in fade-in duration-150">
          {/* 2.1 委派任务描述 */}
          <div className="flex items-start gap-2 text-[11px] text-zinc-300 bg-white/[0.02] border border-white/[0.05] rounded-lg px-2.5 py-2">
            <Bot className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
            <p className="leading-relaxed line-clamp-3 break-words">
              {taskPrompt}
            </p>
          </div>

          {/* 2.2 子代理内部思考过程 (reasoning) */}
          {reasoning && (
            <div className="rounded-lg border border-white/[0.05] bg-black/40 p-2 space-y-1">
              <div className="flex items-center gap-1.5 text-[10px] font-medium text-zinc-400 uppercase tracking-wider">
                <BrainCircuit className="w-3 h-3 text-sky-400" />
                <span>内部思考流 (Reasoning)</span>
              </div>
              <div className="font-mono text-[11px] text-zinc-400 whitespace-pre-wrap break-words max-h-28 overflow-y-auto scrollbar-thin leading-relaxed">
                {reasoning}
              </div>
            </div>
          )}

          {/* 2.3 正在调用 / 已执行的工具步骤列表 */}
          {steps.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider px-0.5">
                工具调用流 ({steps.length})
              </div>
              <div className="space-y-1 max-h-36 overflow-y-auto scrollbar-thin pr-0.5">
                {steps.map((step, idx) => (
                  <div
                    key={`${step.toolCallId || step.index}-${idx}`}
                    className="flex items-start gap-2 px-2 py-1.5 rounded-md bg-white/[0.02] border border-white/[0.04]"
                  >
                    {step.status === "running" ? (
                      <Loader2 className="w-3 h-3 text-sky-400 animate-spin shrink-0 mt-0.5" />
                    ) : (
                      <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" />
                    )}
                    <StepMiniIcon toolName={step.toolName} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-200">
                        <span className="text-zinc-500">#{step.index}</span>
                        <span className="truncate">
                          {step.toolName.replace(/^workspace__/, "")}
                        </span>
                      </div>
                      {step.preview && (
                        <p className="text-[11px] text-zinc-400 truncate mt-0.5">
                          {step.preview}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 2.4 实时输出摘要 */}
          {summary && (
            <div className="rounded-lg border border-white/[0.05] bg-[#16161A] p-2 space-y-1">
              <div className="flex items-center gap-1.5 text-[10px] font-medium text-emerald-400">
                <Sparkles className="w-3 h-3" />
                <span>输出摘要</span>
              </div>
              <p className="text-[11px] text-zinc-300 whitespace-pre-wrap break-words max-h-32 overflow-y-auto scrollbar-thin leading-relaxed">
                {summary}
              </p>
            </div>
          )}

          {/* 2.5 操作反馈提示条 */}
          {feedbackBanner && (
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] border ${
                feedbackBanner.type === "success"
                  ? "bg-emerald-500/10 border-emerald-500/25 text-emerald-300"
                  : "bg-rose-500/10 border-rose-500/25 text-rose-300"
              }`}
            >
              {feedbackBanner.type === "success" ? (
                <Check className="w-3 h-3 shrink-0" />
              ) : (
                <AlertCircle className="w-3 h-3 shrink-0" />
              )}
              <span>{feedbackBanner.text}</span>
            </div>
          )}

          {/* 3. 内联单点控制栏：Inline Steer + Stop Subagent + 右侧栏聚焦 */}
          <div className="pt-1.5 border-t border-white/[0.06] flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            {/* 中途插话输入框 (Inline Steer) */}
            <form
              onSubmit={handleSteerSubmit}
              className="flex-1 flex items-center gap-1.5 bg-[#1A1A1F] border border-white/[0.08] focus-within:border-sky-500/40 rounded-lg px-2 py-1 transition-colors"
            >
              <input
                type="text"
                value={steerInput}
                onChange={(e) => setSteerInput(e.target.value)}
                disabled={status !== "running" || isSteering}
                placeholder={
                  status === "running"
                    ? "中途插话纠偏该子代理方向 (Enter 发送)..."
                    : "子代理已结束，可在右侧栏查看完整日志"
                }
                className="bg-transparent text-xs text-white placeholder:text-zinc-500 outline-none flex-1 min-w-0 disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <button
                type="submit"
                disabled={status !== "running" || isSteering || !steerInput.trim()}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-sky-600/80 hover:bg-sky-500 disabled:bg-zinc-800 disabled:text-zinc-500 text-white text-[11px] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed shrink-0"
                title="发送实时纠偏指令 (POST /subagents/{agent_id}/steer)"
              >
                {isSteering ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Send className="w-3 h-3" />
                )}
                <span>纠偏</span>
              </button>
            </form>

            {/* 单点终止 + 右侧栏联动按钮 */}
            <div className="flex items-center gap-1.5 shrink-0">
              {status === "running" && (
                <button
                  type="button"
                  onClick={handleStopSubagent}
                  disabled={isStopping}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-50"
                  title="单点终止该子代理并释放其锁，不影响主 Agent"
                >
                  {isStopping ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Square className="w-2.5 h-2.5 fill-current" />
                  )}
                  <span>终止</span>
                </button>
              )}

              <button
                type="button"
                onClick={handleFocusInWorkbench}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-zinc-200 hover:text-white text-[11px] font-medium transition-colors cursor-pointer"
                title="在右侧栏聚焦查看该子代理完整日志"
              >
                <PanelRightOpen className="w-3 h-3" />
                <span>完整日志</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
