"use client";

import React, { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  Eye,
  ListTree,
  Terminal,
  FileSearch,
  ChevronDown,
  BrainCircuit,
  Copy,
  Check,
  Sparkles,
  ShieldAlert,
  Settings,
  FileText,
} from "lucide-react";
import {
  SubagentPanelTabConfig,
  SubagentInstance,
  useWorkbenchStore,
} from "@/stores/useWorkbenchStore";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { ThinkingPulse } from "@/components/chat/ThinkingPulse";

interface SubagentPanelViewProps {
  tab: SubagentPanelTabConfig;
}

function StepIcon({ toolName }: { toolName: string }) {
  if (toolName.includes("read_file")) return <Eye className="w-3.5 h-3.5 text-zinc-400 shrink-0" />;
  if (toolName.includes("list_dir")) return <ListTree className="w-3.5 h-3.5 text-zinc-400 shrink-0" />;
  if (toolName.includes("grep") || toolName.includes("find"))
    return <FileSearch className="w-3.5 h-3.5 text-zinc-400 shrink-0" />;
  if (toolName.includes("execute")) return <Terminal className="w-3.5 h-3.5 text-zinc-400 shrink-0" />;
  return <Circle className="w-3 h-3 text-zinc-500 shrink-0" />;
}

function extractStepSummary(steps: SubagentInstance["steps"]): string {
  const categories = new Set<string>();
  for (const s of steps) {
    const name = s.toolName || "";
    if (name.includes("read_file")) categories.add("读取了文件");
    else if (name.includes("list_dir")) categories.add("浏览了目录");
    else if (name.includes("grep") || name.includes("find")) categories.add("检索了代码");
    else if (name.includes("execute")) categories.add("运行了命令");
  }
  if (categories.size === 0) {
    return `${steps.length} 项操作`;
  }
  return Array.from(categories).join(" · ");
}

/**
 * 兜底识别历史缓存中伪装成 completed 的失败记录，并清洗 Python dict 原始报错串
 */
function resolveAgentFailure(agent: SubagentInstance): {
  isFailed: boolean;
  errorCode?: string;
  errorMessage: string;
} {
  const rawSummary = (agent.summary || "").trim();
  const legacyFailPrefix = /^\[(?:子代理执行完成|Subagent 异常终止|Subagent 调查结束)\][^\n]*未能生成(?:最终)?完整报告:\s*/i;
  const isLegacyFakeCompleted = legacyFailPrefix.test(rawSummary);

  const isFailed = agent.status === "failed" || isLegacyFakeCompleted;
  if (!isFailed) {
    return { isFailed: false, errorMessage: "" };
  }

  let rawErr =
    (agent.errorMessage || "").trim() ||
    (isLegacyFakeCompleted ? rawSummary.replace(legacyFailPrefix, "").trim() : rawSummary) ||
    "子代理执行中断，未能生成有效分析报告";

  let errorCode = agent.errorCode;

  // 清洗形如 400: {'error': {'code': 'VALIDATION_ERROR', 'message': '...', 'details': None}}
  const msgMatch = rawErr.match(/['"]message['"]\s*:\s*['"]([^'"]+)['"]/);
  const codeMatch = rawErr.match(/['"]code['"]\s*:\s*['"]([^'"]+)['"]/);
  if (msgMatch?.[1]) {
    rawErr = msgMatch[1].trim();
  }
  if (!errorCode && codeMatch?.[1]) {
    errorCode = codeMatch[1].trim();
  }

  return {
    isFailed: true,
    errorCode,
    errorMessage: rawErr,
  };
}

function getAgentRoleLabel(agentType: SubagentInstance["agentType"]): string {
  if (agentType === "code_worker") return "代码实现";
  if (agentType === "verify") return "质量验证";
  return "调研探索";
}

function sanitizePromptDisplay(prompt: string): string {
  if (!prompt) return "自主代码库架构与依赖分析调研任务";
  // 弱化本机绝对用户目录前缀，避免在面客界面暴露冗长的 /Users/xxx/...
  return prompt.replace(/\/Users\/[^/\s]+\/Desktop\/[^/\s]+\//g, "");
}

export function SubagentPanelView({ tab }: SubagentPanelViewProps) {
  const router = useRouter();
  const setActiveAgent = useWorkbenchStore((s) => s.setActiveAgent);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsDropdownOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDropdownOpen]);

  const [isThinkingOpen, setIsThinkingOpen] = useState(false);
  const [isActionsOpen, setIsActionsOpen] = useState(true);

  const agents = tab.agents || [];
  const totalAgents = agents.length;
  const failedAgents = agents.filter((a) => resolveAgentFailure(a).isFailed).length;
  const completedAgents = agents.filter(
    (a) => a.status === "completed" && !resolveAgentFailure(a).isFailed
  ).length;
  const runningAgents = agents.filter((a) => a.status === "running").length;

  const activeAgent =
    agents.find((a) => a.id === tab.activeAgentId) || agents[0] || null;
  const activeFailure = activeAgent
    ? resolveAgentFailure(activeAgent)
    : { isFailed: false, errorMessage: "" };

  const isAuthError =
    activeFailure.isFailed &&
    (activeFailure.errorCode === "VALIDATION_ERROR" ||
      activeFailure.errorCode === "AUTH_ERROR" ||
      /api\s*key|密钥|401|鉴权/i.test(activeFailure.errorMessage));

  // 切换代理时重置指令折叠态
  useEffect(() => {
    setIsPromptExpanded(false);
  }, [activeAgent?.id]);

  const handleCopy = async (text: string, isSummary: boolean) => {
    try {
      await navigator.clipboard.writeText(text);
      if (isSummary) {
        setCopiedSummary(true);
        setTimeout(() => setCopiedSummary(false), 1500);
      } else {
        setCopiedPrompt(true);
        setTimeout(() => setCopiedPrompt(false), 1500);
      }
    } catch {}
  };

  const displayPrompt = activeAgent
    ? sanitizePromptDisplay(activeAgent.taskPrompt)
    : "";

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#111113] text-[#ECECED]">
      {/* 顶部一体化胶囊导航与真实状态统计条 */}
      <div className="px-3 py-2 border-b border-white/[0.06] bg-[#161618] flex items-center justify-between gap-2 shrink-0">
        {/* 左侧：子代理分段切换栏 */}
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none min-w-0 flex-1">
          {agents.length === 0 ? (
            <div className="flex items-center gap-1.5 text-xs text-zinc-500 py-0.5">
              <Bot className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              <span>暂无协作代理</span>
            </div>
          ) : (
            agents.map((agent) => {
              const isSelected = activeAgent?.id === agent.id;
              const failInfo = resolveAgentFailure(agent);
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => setActiveAgent(agent.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all duration-150 shrink-0 cursor-pointer select-none ${
                    isSelected
                      ? "bg-[#2D2D30] text-white font-medium shadow-sm border border-white/[0.12]"
                      : "bg-transparent text-[#9E9EA4] hover:text-white hover:bg-white/[0.04] border border-transparent"
                  }`}
                  title={`${agent.displayName || "协作代理"} (${getAgentRoleLabel(agent.agentType)})`}
                >
                  {agent.status === "running" ? (
                    <Loader2 className="w-3 h-3 text-amber-400 animate-spin shrink-0" />
                  ) : failInfo.isFailed ? (
                    <XCircle className="w-3 h-3 text-rose-400 shrink-0" />
                  ) : agent.status === "completed" ? (
                    <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="w-3 h-3 text-zinc-400 shrink-0" />
                  )}
                  <span className="truncate max-w-[140px] sm:max-w-[180px]">
                    {agent.displayName || "协作代理"}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* 右侧：准确反映运行/成功/失败的统计胶囊 */}
        {agents.length > 0 && (
          <div ref={dropdownRef} className="relative flex items-center gap-1.5 shrink-0 pl-1">
            {runningAgents > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-amber-500/10 text-amber-300 border-amber-500/25 shrink-0">
                <Loader2 className="w-2.5 h-2.5 animate-spin text-amber-400 shrink-0" />
                <span>{runningAgents} 运行中</span>
              </span>
            )}

            <button
              type="button"
              onClick={() => setIsDropdownOpen((prev) => !prev)}
              className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-medium border transition-all cursor-pointer select-none ${
                failedAgents > 0
                  ? "bg-rose-500/10 text-rose-300 border-rose-500/30 hover:bg-rose-500/15"
                  : isDropdownOpen
                  ? "bg-[#2D2D30] text-white border-white/[0.2] shadow-sm"
                  : "bg-white/[0.04] text-[#9E9EA4] hover:text-white hover:bg-white/[0.08] border-white/[0.06]"
              }`}
              title="点击查看所有协作代理并切换"
            >
              <span>
                {failedAgents > 0
                  ? `${completedAgents}/${totalAgents} 成功 · ${failedAgents} 失败`
                  : `${completedAgents}/${totalAgents} 完成`}
              </span>
              <ChevronDown
                className={`w-2.5 h-2.5 transition-transform duration-150 ${
                  isDropdownOpen ? "rotate-180 text-white" : "opacity-70"
                }`}
              />
            </button>

            {isDropdownOpen && (
              <div className="absolute right-0 top-full mt-1.5 z-50 w-72 sm:w-84 rounded-xl bg-[#1A1A1E] border border-white/[0.1] shadow-2xl shadow-black/80 p-1.5 animate-in fade-in zoom-in-95 duration-150 select-none">
                <div className="flex items-center justify-between px-2.5 py-1.5 mb-1 border-b border-white/[0.06] text-[11px] font-medium text-zinc-400">
                  <span>协作代理列表</span>
                  <span className="text-[10px] font-mono text-zinc-500">
                    共 {totalAgents} 个
                  </span>
                </div>
                <div className="max-h-72 overflow-y-auto space-y-0.5 scrollbar-thin">
                  {agents.map((agent) => {
                    const isSelected = activeAgent?.id === agent.id;
                    const failInfo = resolveAgentFailure(agent);
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => {
                          setActiveAgent(agent.id);
                          setIsDropdownOpen(false);
                        }}
                        className={`w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors cursor-pointer ${
                          isSelected
                            ? "bg-[#2A2A2E] text-white border border-white/[0.08]"
                            : "hover:bg-white/[0.04] text-zinc-300 border border-transparent"
                        }`}
                      >
                        <div className="mt-0.5 shrink-0">
                          {agent.status === "running" ? (
                            <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                          ) : failInfo.isFailed ? (
                            <XCircle className="w-3.5 h-3.5 text-rose-400" />
                          ) : agent.status === "completed" ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <XCircle className="w-3.5 h-3.5 text-zinc-400" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-xs font-medium truncate text-white">
                              {agent.displayName || "协作代理"}
                            </span>
                            {isSelected && (
                              <Check className="w-3 h-3 text-blue-400 shrink-0" />
                            )}
                          </div>
                          {agent.taskPrompt && (
                            <p className="text-[11px] text-zinc-400/80 truncate mt-0.5">
                              {sanitizePromptDisplay(agent.taskPrompt)}
                            </p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 主体视口：结论与错误优先，任务指令降噪为默认折叠的次级卡片 */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 scrollbar-thin select-text">
        {!activeAgent ? (
          <div className="h-64 flex flex-col items-center justify-center text-center text-zinc-500 space-y-2">
            <Bot className="w-8 h-8 opacity-40 text-blue-400" />
            <p className="text-xs">暂无协作代理任务</p>
            <p className="text-[11px] text-zinc-600 max-w-xs">
              当主对话委派子代理进行深度调研、实现或验证时，其实时进度与报告将在此呈现。
            </p>
          </div>
        ) : (
          <div className="space-y-3.5">
            {/* 1. 语义化角色与权限范围元信息（隐藏无意义的内部 subagent_1_xxx 哈希 ID） */}
            <div className="flex items-center flex-wrap gap-1.5 text-[11px]">
              <span
                className={`px-2 py-0.5 rounded-md border font-medium ${
                  activeAgent.agentType === "code_worker"
                    ? "bg-violet-500/12 text-violet-300 border-violet-500/25"
                    : activeAgent.agentType === "verify"
                    ? "bg-emerald-500/12 text-emerald-300 border-emerald-500/25"
                    : "bg-sky-500/12 text-sky-300 border-sky-500/25"
                }`}
                title={`实例标识: ${activeAgent.id}`}
              >
                {getAgentRoleLabel(activeAgent.agentType)}
              </span>

              {activeAgent.status === "terminated" && (
                <span className="px-2 py-0.5 rounded-md bg-amber-500/12 border border-amber-500/25 text-amber-300 font-medium">
                  已中断
                </span>
              )}

              {activeAgent.writeScope && activeAgent.writeScope.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  {activeAgent.writeScope.map((scope) => (
                    <span
                      key={scope}
                      className="px-1.5 py-0.5 rounded bg-violet-950/40 border border-violet-500/25 font-mono text-[10px] text-violet-200"
                    >
                      🔒 {scope}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* 2. 低饱和度可折叠任务指令卡（默认收拢 2 行，不再用刺眼大蓝泡霸屏） */}
            <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.05]">
                <button
                  type="button"
                  onClick={() => setIsPromptExpanded((prev) => !prev)}
                  className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  <span>任务指令</span>
                  <ChevronDown
                    className={`w-3 h-3 text-zinc-500 transition-transform duration-150 ${
                      isPromptExpanded ? "rotate-180" : ""
                    }`}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => handleCopy(activeAgent.taskPrompt || "", false)}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors cursor-pointer"
                  title="复制完整任务指令"
                >
                  {copiedPrompt ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-400">已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>复制</span>
                    </>
                  )}
                </button>
              </div>
              <div
                onClick={() => !isPromptExpanded && setIsPromptExpanded(true)}
                className={`px-3 py-2.5 text-xs text-zinc-300/90 leading-relaxed whitespace-pre-wrap break-words ${
                  !isPromptExpanded
                    ? "line-clamp-2 cursor-pointer hover:text-zinc-200"
                    : "max-h-72 overflow-y-auto scrollbar-thin"
                }`}
              >
                {displayPrompt}
              </div>
            </div>

            {/* 3. 深度思考折叠仓 */}
            {activeAgent.thinkingContent && (
              <div className="rounded-xl border border-white/[0.06] bg-black/40 overflow-hidden shadow-sm">
                <button
                  type="button"
                  onClick={() => setIsThinkingOpen(!isThinkingOpen)}
                  className="w-full flex items-center justify-between px-3.5 py-2.5 text-left hover:bg-white/[0.02] transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2 text-xs font-medium text-zinc-300">
                    <BrainCircuit className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                    <span>思考逻辑与规划</span>
                  </div>
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-zinc-500 transition-transform duration-200 ${
                      isThinkingOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
                {isThinkingOpen && (
                  <div className="px-3.5 pb-3.5 pt-1.5 border-t border-white/[0.04] text-[11px] text-zinc-400 font-mono leading-relaxed whitespace-pre-wrap break-words max-h-56 overflow-y-auto scrollbar-thin">
                    {activeAgent.thinkingContent}
                  </div>
                )}
              </div>
            )}

            {/* 4. 工具动作折叠时间线 */}
            {activeAgent.steps.length > 0 && (
              <div className="rounded-xl border border-white/[0.06] bg-[#161618] overflow-hidden shadow-sm">
                <button
                  type="button"
                  onClick={() => setIsActionsOpen(!isActionsOpen)}
                  className="w-full flex items-center justify-between px-3.5 py-2.5 text-left hover:bg-white/[0.02] transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
                    {activeAgent.status === "running" ? (
                      <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
                    ) : activeFailure.isFailed ? (
                      <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    )}
                    <span>
                      {extractStepSummary(activeAgent.steps)} ({activeAgent.steps.length} 步)
                    </span>
                  </div>
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-zinc-500 transition-transform duration-200 ${
                      isActionsOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {isActionsOpen && (
                  <div className="px-3.5 pb-3 pt-1 border-t border-white/[0.04] space-y-1.5 max-h-56 overflow-y-auto scrollbar-thin">
                    {activeAgent.steps.map((step) => (
                      <div
                        key={step.index}
                        className="flex items-start gap-2 py-1.5 px-2 rounded-lg bg-white/[0.02] text-xs"
                      >
                        {step.status === "running" ? (
                          <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0 mt-0.5" />
                        ) : (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 text-xs">
                            <span className="text-zinc-500 font-mono text-[11px] shrink-0">
                              Step {step.index}
                            </span>
                            <StepIcon toolName={step.toolName} />
                            <span className="text-zinc-200 font-mono truncate">
                              {step.toolName.replace(/^workspace__/, "")}
                            </span>
                          </div>
                          {step.preview && (
                            <p className="text-[11px] text-zinc-400 mt-1 break-all [overflow-wrap:anywhere] leading-normal font-sans">
                              {step.preview}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 5. 等待脉冲动效 */}
            {activeAgent.status === "running" && !activeAgent.summary && !activeFailure.isFailed && (
              <div className="py-2 px-1">
                <ThinkingPulse />
              </div>
            )}

            {/* 6. 结构化失败卡片（优先于结论区：失败态严禁展示绿色“分析调研结论”和“复制报告”） */}
            {activeFailure.isFailed ? (
              <div className="rounded-xl bg-rose-950/25 border border-rose-500/30 p-4 space-y-3">
                <div className="flex items-start gap-2.5">
                  <ShieldAlert className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-rose-200">
                        协作代理执行失败
                      </span>
                      {activeFailure.errorCode && (
                        <span className="px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/25 text-[10px] font-mono text-rose-300">
                          {activeFailure.errorCode}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-rose-200/85 leading-relaxed break-words">
                      {activeFailure.errorMessage}
                    </p>
                  </div>
                </div>

                {isAuthError && (
                  <div className="pt-1 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => router.push("/settings?tab=models")}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-400/35 text-xs font-medium text-rose-100 transition-colors cursor-pointer"
                    >
                      <Settings className="w-3.5 h-3.5" />
                      <span>前往配置 API Key</span>
                    </button>
                  </div>
                )}
              </div>
            ) : activeAgent.summary ? (
              /* 7. 最终调研结论正文 */
              <div className="space-y-3 pt-1">
                <div className="flex items-center justify-between pb-1.5 border-b border-white/[0.06]">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                    <Sparkles className="w-3.5 h-3.5 shrink-0" />
                    <span>分析调研结论</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopy(activeAgent.summary || "", true)}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
                    title="复制完整报告"
                  >
                    {copiedSummary ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400" />
                        <span className="text-emerald-400">已复制</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>复制报告</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="text-sm text-[#ECECED] leading-relaxed select-text space-y-2">
                  <MarkdownRenderer
                    content={activeAgent.summary}
                    isStreaming={activeAgent.status === "running"}
                  />
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export { SubagentPanelView as SubagentTabView };
