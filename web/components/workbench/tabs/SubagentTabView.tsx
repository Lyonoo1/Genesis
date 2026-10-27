"use client";

import React, { useState, useRef, useEffect } from "react";
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

// 提炼执行动作类别摘要
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
  return Array.from(categories).join(" ");
}

export function SubagentPanelView({ tab }: SubagentPanelViewProps) {
  const setActiveAgent = useWorkbenchStore((s) => s.setActiveAgent);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部自动收起气泡
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

  // 思考过程与动作时间线折叠状态（默认打开思考过程和动作流）
  const [isThinkingOpen, setIsThinkingOpen] = useState(false);
  const [isActionsOpen, setIsActionsOpen] = useState(true);

  const agents = tab.agents || [];
  const totalAgents = agents.length;
  const completedAgents = agents.filter((a) => a.status === "completed").length;
  const runningAgents = agents.filter((a) => a.status === "running").length;

  // 当前选中的代理实例：若未指定则默认选第一个
  const activeAgent =
    agents.find((a) => a.id === tab.activeAgentId) || agents[0] || null;

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

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#111113] text-[#ECECED]">
      {/* 顶部单层一体化胶囊导航与状态条（彻底移除重复大标题） */}
      <div className="px-3 py-2 border-b border-white/[0.06] bg-[#161618] flex items-center justify-between gap-2 shrink-0">
        {/* 左侧：子代理胶囊分段切换栏 */}
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none min-w-0 flex-1">
          {agents.length === 0 ? (
            <div className="flex items-center gap-1.5 text-xs text-zinc-500 py-0.5">
              <Bot className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              <span>暂无协作代理</span>
            </div>
          ) : (
            agents.map((agent) => {
              const isSelected = activeAgent?.id === agent.id;
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
                  title={agent.displayName || agent.id}
                >
                  {agent.status === "running" ? (
                    <Loader2 className="w-3 h-3 text-amber-400 animate-spin shrink-0" />
                  ) : agent.status === "completed" ? (
                    <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle className="w-3 h-3 text-red-400 shrink-0" />
                  )}
                  <span className="truncate max-w-[140px] sm:max-w-[180px]">
                    {agent.displayName || agent.id}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* 右侧：紧凑进度与运行中动效 + 气泡下拉选择器 */}
        {agents.length > 0 && (
          <div ref={dropdownRef} className="relative flex items-center gap-1.5 shrink-0 pl-1">
            {runningAgents > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border bg-white/[0.06] text-amber-300 border-amber-500/20 shrink-0">
                <Loader2 className="w-2.5 h-2.5 animate-spin text-amber-400 shrink-0" />
                <span>{runningAgents} 运行中</span>
              </span>
            )}

            <button
              type="button"
              onClick={() => setIsDropdownOpen((prev) => !prev)}
              className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-medium border transition-all cursor-pointer select-none ${
                isDropdownOpen
                  ? "bg-[#2D2D30] text-white border-white/[0.2] shadow-sm"
                  : "bg-white/[0.04] text-[#9E9EA4] hover:text-white hover:bg-white/[0.08] border-white/[0.06]"
              }`}
              title="点击查看所有协作代理并切换"
            >
              <span>{completedAgents}/{totalAgents} 完成</span>
              <ChevronDown
                className={`w-2.5 h-2.5 transition-transform duration-150 ${
                  isDropdownOpen ? "rotate-180 text-white" : "text-[#71717A]"
                }`}
              />
            </button>

            {/* 下拉选择气泡列表 */}
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
                          ) : agent.status === "completed" ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <XCircle className="w-3.5 h-3.5 text-red-400" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-xs font-medium truncate text-white">
                              {agent.displayName || agent.id}
                            </span>
                            {isSelected && (
                              <Check className="w-3 h-3 text-blue-400 shrink-0" />
                            )}
                          </div>
                          {agent.taskPrompt && (
                            <p className="text-[11px] text-zinc-400/80 truncate mt-0.5">
                              {agent.taskPrompt}
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

      {/* 3. 对话流主体视口 (与主聊天窗口风格一致) */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 scrollbar-thin select-text">
        {!activeAgent ? (
          <div className="h-64 flex flex-col items-center justify-center text-center text-zinc-500 space-y-2">
            <Bot className="w-8 h-8 opacity-40 text-blue-400" />
            <p className="text-xs">暂无协作代理任务</p>
            <p className="text-[11px] text-zinc-600 max-w-xs">
              当在主对话中调度子代理进行深度调研或验证时，其实时对话流将在此完整呈现。
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* 3.1 用户/主代理任务提问气泡 (对标 UserMessageItem: Codex 经典深蓝圆角气泡) */}
            <div className="flex flex-col items-end my-2 group select-text">
              <div className="max-w-[92%] rounded-[18px] px-4 py-3 bg-[#183E76] shadow-[0_2px_12px_rgba(24,62,118,0.35)] select-text transition-all">
                <div className="flex items-center justify-between gap-3 text-[10px] text-blue-200/70 mb-1.5 font-medium">
                  <span className="uppercase tracking-wider">下发任务指令</span>
                  <button
                    type="button"
                    onClick={() => handleCopy(activeAgent.taskPrompt, false)}
                    className="p-0.5 hover:text-white transition-colors cursor-pointer"
                    title="复制任务指令"
                  >
                    {copiedPrompt ? (
                      <Check className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3 text-blue-200/70" />
                    )}
                  </button>
                </div>
                <p className="text-xs text-white leading-relaxed whitespace-pre-wrap break-words">
                  {activeAgent.taskPrompt || "自主代码库架构与依赖分析调研任务"}
                </p>
              </div>
            </div>

            {/* 3.2 深度思考折叠仓 (如果有思维链/规划思考，对标 ThinkingAccordion) */}
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

            {/* 3.3 工具动作折叠时间线 (对标 ActionTimeline: 动作汇总 + 节点) */}
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
                              {step.toolName}
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

            {/* 3.4 思考等待脉冲动效 (子代理正在运行且尚未产出正文时) */}
            {activeAgent.status === "running" && !activeAgent.summary && (
              <div className="py-2 px-1">
                <ThinkingPulse />
              </div>
            )}

            {/* 3.5 最终结论正文渲染 (直接复用 MarkdownRenderer，呈现完整 Markdown 报告) */}
            {activeAgent.summary ? (
              <div className="space-y-3 pt-1">
                <div className="flex items-center justify-between pb-1 border-b border-white/[0.06]">
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

                {/* Markdown 格式化排版内容容器 */}
                <div className="text-sm text-[#ECECED] leading-relaxed select-text space-y-2">
                  <MarkdownRenderer
                    content={activeAgent.summary}
                    isStreaming={activeAgent.status === "running"}
                  />
                </div>
              </div>
            ) : null}

            {/* 3.6 失败状态提示 */}
            {activeAgent.status === "failed" && !activeAgent.summary && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-red-950/20 border border-red-500/20 text-xs text-red-300">
                <ShieldAlert className="w-4 h-4 shrink-0 text-red-400" />
                <span>子代理执行中断或未生成最终分析报告</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// 兼容旧导出
export { SubagentPanelView as SubagentTabView };
