"use client";

import React, { useState, useRef, useEffect, useMemo } from "react";
import {
  ArrowUp,
  AtSign,
  Hand,
  Square,
  ChevronDown,
  Check,
  AlertCircle,
  HardDrive,
  Gauge,
  CornerDownRight,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { ModelSelectorPopover } from "./ModelSelectorPopover";
import { RunningTasksBanner } from "./RunningTasksBanner";
import { SteeringQueueDrawer } from "./SteeringQueueDrawer";
import {
  SkillMentionDropdown,
  SkillOption,
  filterMentionOptions,
} from "./SkillMentionDropdown";
import { ActiveSkillChip } from "./ActiveSkillChip";
import { ConfirmationDock } from "@/components/agent-confirmation/ConfirmationDock";
import { useConfirmationStore } from "@/components/agent-confirmation/store/useConfirmationStore";
import { useChatStore } from "@/stores/useChatStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useModelConfigStore } from "@/stores/useModelConfigStore";
import { useMarketplaceStore } from "@/stores/useMarketplaceStore";
import { useLocalWorkspace } from "@/hooks/useLocalWorkspace";
import { pickFolder } from "@/lib/workspace/pickFolder";
import { saveDirectoryHandle } from "@/lib/workspace/localWorkspaceManager";

interface ChatInputBarProps {
  sessionId?: string | null;
  initialPrompt?: string;
  onSendWithPrompt?: (
    prompt: string,
    mode?: "plan" | "act",
    skillId?: string | null
  ) => void;
  onHeightChange?: (height: number) => void;
  scrollbarWidth?: number;
}

function formatCompactTokens(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

function inferFrontendContextWindow(
  modelName?: string,
  explicitWindow?: number | null
): number {
  const lower = (modelName || "").toLowerCase();
  const supports1M =
    lower.includes("gemini") ||
    lower.includes("qwen-long") ||
    lower.includes("1m") ||
    lower.includes("gpt-4.1");
  if (explicitWindow && explicitWindow > 0) {
    if (explicitWindow !== 1048576 || supports1M) {
      return explicitWindow;
    }
  }
  if (supports1M) return 1048576;
  if (lower.includes("deepseek")) return 131072;
  if (lower.includes("claude") || lower.includes("anthropic")) return 200000;
  return 128000;
}

function formatModelDisplayName(rawName?: string): string {
  if (!rawName) return "自定义模型";
  if (rawName.trim().toLowerCase() === "deepseek") return "DeepSeek";
  return rawName.replace(/\bdeepseek\b/gi, "DeepSeek");
}

export function ChatInputBar({
  sessionId,
  initialPrompt = "",
  onSendWithPrompt,
  onHeightChange,
  scrollbarWidth = 0,
}: ChatInputBarProps) {
  const router = useRouter();
  const {
    sendStreamMessage,
    sendSteerMessage,
    enqueueSteering,
    stopGeneration,
    setRunMode,
  } = useChatStore();
  const {
    activeProjectId,
    activeSessionId,
    sessions,
    projects,
    updateProject,
    reasoningEffort,
    createSession,
  } = useSessionStore();
  const { getActiveModel } = useModelConfigStore();
  const activeModel = getActiveModel();
  const marketplacePlugins = useMarketplaceStore((s) => s.plugins || []);
  const installedPluginIds = useMarketplaceStore((s) => s.installedPluginIds || []);
  const installedPlugins = useMemo(
    () => marketplacePlugins.filter((p) => installedPluginIds.includes(p.id)),
    [marketplacePlugins, installedPluginIds]
  );

  const effectiveSessionId = sessionId || activeSessionId || null;
  const sessionScopeKey = effectiveSessionId || "draft";
  const isStreaming = useChatStore((s) =>
    s.isStreamingForSession(effectiveSessionId)
  );

  const permissionMode = useConfirmationStore((s) => s.permissionMode);
  const setPermissionMode = useConfirmationStore((s) => s.setPermissionMode);
  const redirectBanner = useConfirmationStore((s) => s.redirectBanner);
  const setRedirectBanner = useConfirmationStore((s) => s.setRedirectBanner);
  const hasPendingConfirmation = useConfirmationStore((s) =>
    effectiveSessionId
      ? (s.bySession[effectiveSessionId] || []).some(
          (e) => e.request.kind !== "plan_approval"
        )
      : false
  );

  const currentRunMode = useChatStore(
    (s) =>
      s.runModeBySession[sessionScopeKey] ??
      (effectiveSessionId ? "act" : s.runMode || "act")
  );
  const contextTelemetry = useChatStore(
    (s) => s.contextTelemetryBySession[sessionScopeKey] ?? null
  );

  const currentSession = (sessions || []).find(
    (s) => s && s.id === effectiveSessionId
  );
  const targetProjectId = currentSession?.project_id || activeProjectId || null;
  const currentProject = targetProjectId
    ? (projects || []).find((p) => p && p.id === targetProjectId)
    : null;

  const {
    status: localStatus,
    directoryName,
    requestAccess,
  } = useLocalWorkspace(targetProjectId);

  const isProjectFolderMissing = Boolean(
    targetProjectId && !currentProject?.folder_name && !currentProject?.folder_path
  );

  const handlePickAndLinkFolder = async () => {
    if (!targetProjectId) return;
    const res = await pickFolder();
    if (res) {
      await updateProject(targetProjectId, {
        folder_name: res.name,
        folder_path: res.path,
      });
      if (res.handle) {
        try {
          await saveDirectoryHandle(targetProjectId, res.handle);
        } catch (dbErr) {
          console.warn("保存本地目录句柄到 IndexedDB 失败:", dbErr);
        }
      }
    }
  };

  const [text, setText] = useState(initialPrompt);
  const [isModelOpen, setIsModelOpen] = useState(false);
  const [isApprovalOpen, setIsApprovalOpen] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [mounted, setMounted] = useState(false);

  // @ 提及菜单与选中技能状态（取代旧 Plan / Act 按钮切换）
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionRange, setMentionRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [selectedSkill, setSelectedSkill] = useState<SkillOption | null>(null);

  const extraMentionOptions: SkillOption[] = useMemo(() => {
    return installedPlugins
      .filter((p) => p && p.name)
      .map((p) => ({
        id: p.id,
        name: p.name.replace(/\s+/g, "-").toLowerCase(),
        label: p.name,
        category: p.type === "mcp" ? "mcp" : "skill",
        description: p.description || "已安装扩展能力",
      }));
  }, [installedPlugins]);

  const filteredMentions = useMemo(
    () => filterMentionOptions(mentionQuery, extraMentionOptions),
    [mentionQuery, extraMentionOptions]
  );

  const isModelConfigured = Boolean(
    mounted &&
      activeModel &&
      activeModel.apiKey &&
      activeModel.apiKey.trim().length > 0
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const barContainerRef = useRef<HTMLDivElement>(null);
  const approvalRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);

  // 点击外部或按 Escape 键关闭审批弹窗
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        approvalRef.current &&
        !approvalRef.current.contains(event.target as Node)
      ) {
        setIsApprovalOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsApprovalOpen(false);
      }
    }
    if (isApprovalOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isApprovalOpen]);

  // 监听输入框区域真实渲染高度
  useEffect(() => {
    const el = barContainerRef.current;
    if (!el || !onHeightChange) return;

    onHeightChange(el.offsetHeight);

    const observer = new ResizeObserver((entries) => {
      window.requestAnimationFrame(() => {
        for (const entry of entries) {
          const h = entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight;
          if (h > 0) {
            onHeightChange(h);
          }
        }
      });
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [onHeightChange]);

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = 260;
    const nextHeight = Math.min(Math.max(el.scrollHeight, 38), maxHeight);
    el.style.height = `${nextHeight}px`;
    setIsOverflowing(el.scrollHeight > maxHeight);
  };

  // 检测光标前是否处于 @mention 触发上下文
  const detectMentionTrigger = (value: string, cursorPos: number) => {
    const beforeCursor = value.slice(0, cursorPos);
    const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    if (match) {
      const atIdx = beforeCursor.lastIndexOf("@");
      setMentionOpen(true);
      setMentionQuery(match[1] || "");
      setMentionRange({ start: atIdx, end: cursorPos });
      setMentionIndex(0);
    } else {
      setMentionOpen(false);
      setMentionQuery("");
      setMentionRange(null);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    adjustHeight();
    detectMentionTrigger(val, e.target.selectionStart ?? val.length);
  };

  const handleSelectMention = (option: SkillOption) => {
    let nextText = text;
    if (mentionRange) {
      const before = text.slice(0, mentionRange.start);
      const after = text.slice(mentionRange.end).replace(/^\s+/, "");
      nextText = (before + after).replace(/^\s+/, "");
    }
    setText(nextText);
    setMentionOpen(false);
    setMentionQuery("");
    setMentionRange(null);

    if (option.category === "mode" && option.modeValue) {
      setRunMode(option.modeValue, sessionScopeKey);
    } else {
      setSelectedSkill(option);
    }

    requestAnimationFrame(() => {
      adjustHeight();
      textareaRef.current?.focus();
    });
  };

  const handleTriggerMentionButton = () => {
    const el = textareaRef.current;
    if (mentionOpen) {
      setMentionOpen(false);
      return;
    }
    const pos = el?.selectionStart ?? text.length;
    const needsSpace = pos > 0 && !/\s$/.test(text.slice(0, pos));
    const inserted = (needsSpace ? " @" : "@");
    const nextText = text.slice(0, pos) + inserted + text.slice(pos);
    const nextCursor = pos + inserted.length;
    setText(nextText);
    setMentionOpen(true);
    setMentionQuery("");
    setMentionRange({ start: nextCursor - 1, end: nextCursor });
    setMentionIndex(0);
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(nextCursor, nextCursor);
      }
      adjustHeight();
    });
  };

  const handleSend = async () => {
    if (!isModelConfigured) {
      router.push("/settings?tab=models");
      return;
    }

    let trimmed = text.trim();
    if (!trimmed) return;

    // 支持直接手打 "@plan 帮我设计..." 或 "@act ..." 发送时自动识别模式
    let effectiveMode: "plan" | "act" = currentRunMode;
    if (/^@plan(?:\s+|$)/i.test(trimmed)) {
      effectiveMode = "plan";
      setRunMode("plan", sessionScopeKey);
      trimmed = trimmed.replace(/^@plan\s*/i, "").trim();
      if (!trimmed) return;
    } else if (/^@act(?:\s+|$)/i.test(trimmed)) {
      effectiveMode = "act";
      setRunMode("act", sessionScopeKey);
      trimmed = trimmed.replace(/^@act\s*/i, "").trim();
      if (!trimmed) return;
    }

    const activeSkillId = selectedSkill?.id || null;

    if (targetProjectId && isProjectFolderMissing) {
      const res = await pickFolder();
      if (res) {
        await updateProject(targetProjectId, {
          folder_name: res.name,
          folder_path: res.path,
        });
        if (res.handle) {
          try {
            await saveDirectoryHandle(targetProjectId, res.handle);
          } catch (dbErr) {
            console.warn("保存本地目录句柄到 IndexedDB 失败:", dbErr);
          }
        }
      }
    }

    const isRedirectActive = Boolean(
      effectiveSessionId && redirectBanner?.sessionId === effectiveSessionId
    );
    const shouldOverrideNow = hasPendingConfirmation || isRedirectActive;

    // Chat Override：发送新消息前乐观关闭当前会话全部确认气泡与纠偏横幅
    if (effectiveSessionId && shouldOverrideNow) {
      useConfirmationStore.getState().resolveAllForSession(effectiveSessionId);
    }

    if (isStreaming) {
      if (effectiveSessionId) {
        if (shouldOverrideNow) {
          // 气泡挂起态或 Deny & Redirect 纠偏态：直接推送到后端 Mid-task Steering 队列并原子结案旧确认
          await sendSteerMessage(effectiveSessionId, trimmed);
        } else {
          await enqueueSteering(effectiveSessionId, trimmed);
        }
        setText("");
        setMentionOpen(false);
        setIsOverflowing(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = "auto";
        }
      }
      return;
    }

    setText("");
    setMentionOpen(false);
    setSelectedSkill(null);
    setIsOverflowing(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    if (onSendWithPrompt) {
      onSendWithPrompt(trimmed, effectiveMode, activeSkillId);
      return;
    }

    let targetSessionId = sessionId;
    if (!targetSessionId) {
      const newSession = await createSession(
        "新对话",
        activeProjectId || undefined
      );
      targetSessionId = newSession.id;
    }

    sendStreamMessage(
      targetSessionId,
      trimmed,
      null,
      activeSkillId,
      effectiveMode
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.nativeEvent.isComposing ||
      isComposingRef.current ||
      e.keyCode === 229
    ) {
      return;
    }

    // @ 提及菜单打开时优先接管键盘导航
    if (mentionOpen && filteredMentions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((prev) => (prev + 1) % filteredMentions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex(
          (prev) => (prev - 1 + filteredMentions.length) % filteredMentions.length
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const chosen = filteredMentions[mentionIndex] || filteredMentions[0];
        if (chosen) handleSelectMention(chosen);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionOpen(false);
        return;
      }
    } else if (mentionOpen && e.key === "Escape") {
      e.preventDefault();
      setMentionOpen(false);
      return;
    }

    if (e.key === "Enter") {
      if (e.shiftKey) {
        requestAnimationFrame(() => adjustHeight());
        return;
      }
      e.preventDefault();
      if (!isModelConfigured) {
        router.push("/settings?tab=models");
        return;
      }
      handleSend();
    }
  };

  React.useEffect(() => {
    if (initialPrompt) {
      setText(initialPrompt);
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
          adjustHeight();
        }
      }, 50);
    }
  }, [initialPrompt]);

  const effortLabel =
    reasoningEffort === "high"
      ? "高"
      : reasoningEffort === "medium"
      ? "中"
      : "轻";

  const contextWindowMax = inferFrontendContextWindow(
    activeModel?.modelId || activeModel?.name,
    contextTelemetry?.context_window || activeModel?.contextWindow
  );
  const contextUsagePct =
    contextTelemetry && contextWindowMax > 0
      ? Math.min(
          100,
          Math.round((contextTelemetry.total_tokens / contextWindowMax) * 100)
        )
      : 0;

  return (
    <div
      ref={barContainerRef}
      style={
        scrollbarWidth > 0 ? { paddingRight: `${scrollbarWidth}px` } : undefined
      }
      className="absolute bottom-0 left-0 right-0 z-30 pointer-events-none flex flex-col justify-end"
    >
      <div className="absolute top-0 h-[24px] left-0 right-0 bg-gradient-to-b from-transparent to-[#161618] pointer-events-none" />
      <div className="absolute top-[24px] bottom-0 left-0 right-0 bg-[#161618] pointer-events-none" />

      <div className="relative z-10 w-full pb-6 px-4 md:px-6 pointer-events-none">
        <div className="max-w-3xl mx-auto relative pointer-events-auto flex flex-col items-start w-full">
          <ConfirmationDock
            sessionId={effectiveSessionId}
            composerRef={textareaRef}
            composerValue={text}
            agentName="Genesis"
            onFillComposerText={(val) => {
              setText(val);
              requestAnimationFrame(() => adjustHeight());
            }}
            onSendRedirectMessage={(msg) => {
              if (effectiveSessionId) {
                void sendSteerMessage(effectiveSessionId, msg);
              }
            }}
          />

          {/* Deny & Redirect 纠偏横幅 */}
          {effectiveSessionId &&
            redirectBanner?.sessionId === effectiveSessionId && (
              <div className="w-full mb-2 px-3.5 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between text-xs text-amber-200 animate-in fade-in slide-in-from-bottom-1 duration-150">
                <div className="flex items-center gap-2 min-w-0">
                  <CornerDownRight className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span className="truncate">
                    纠偏指令将发送给 Genesis，请在下方输入调整方向后回车发送
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setRedirectBanner(null)}
                  aria-label="取消纠偏模式"
                  className="px-2 py-0.5 rounded-md text-amber-300/80 hover:text-amber-200 hover:bg-amber-500/15 transition-colors flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <X className="w-3 h-3" />
                  <span>取消</span>
                </button>
              </div>
            )}

          <SteeringQueueDrawer
            sessionId={sessionId}
            onFillText={(val) => {
              setText(val);
              adjustHeight();
            }}
          />

          {targetProjectId &&
            (isProjectFolderMissing || localStatus === "NEED_PERMISSION") && (
              <div className="w-full mb-2.5 px-3.5 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between text-xs text-amber-300 backdrop-blur-md shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200">
                <div className="flex items-center gap-2 min-w-0 pr-2">
                  <HardDrive className="w-4 h-4 text-amber-400 shrink-0" />
                  <span className="truncate">
                    {localStatus === "NEED_PERMISSION"
                      ? `项目「${currentProject?.name || "当前项目"}」已关联文件夹「${currentProject?.folder_name || directoryName}」，需轻点授权访问本地文件`
                      : `项目「${currentProject?.name || "当前项目"}」尚未关联本地文件夹，建议关联以同步代码`}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={
                    localStatus === "NEED_PERMISSION"
                      ? requestAccess
                      : handlePickAndLinkFolder
                  }
                  className="px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-medium transition-colors cursor-pointer text-xs shrink-0 shadow-sm"
                >
                  {localStatus === "NEED_PERMISSION" ? "点击授权" : "立即关联文件夹"}
                </button>
              </div>
            )}

          {/* 主输入卡片容器 */}
          <div
            className={`w-full rounded-[20px] border bg-[#2A2A2A] shadow-[0_12px_36px_rgba(0,0,0,0.55)] transition-all duration-200 focus-within:ring-1 focus-within:ring-white/[0.08] relative ${
              currentRunMode === "plan"
                ? "border-indigo-500/45 focus-within:border-indigo-400/70"
                : "border-[#383838]/60 focus-within:border-[#484848]"
            }`}
          >
            {/* @ 快捷召唤下拉面板 */}
            {mentionOpen && (
              <SkillMentionDropdown
                query={mentionQuery}
                selectedIndex={mentionIndex}
                onSelect={handleSelectMention}
                onClose={() => setMentionOpen(false)}
                setSelectedIndex={setMentionIndex}
                extraOptions={extraMentionOptions}
              />
            )}

            <RunningTasksBanner sessionId={sessionId} />

            <div className="p-3">
              {/* 已激活的 @plan 模式 / @技能 胶囊栏 */}
              {(currentRunMode === "plan" || selectedSkill) && (
                <div className="flex items-center flex-wrap gap-1.5 px-1.5 pb-2">
                  {currentRunMode === "plan" && (
                    <ActiveSkillChip
                      skillName="plan"
                      label="规划模式"
                      variant="mode"
                      onRemove={() => setRunMode("act", sessionScopeKey)}
                    />
                  )}
                  {selectedSkill && (
                    <ActiveSkillChip
                      skillName={selectedSkill.name}
                      label={selectedSkill.label}
                      variant="skill"
                      onRemove={() => setSelectedSkill(null)}
                    />
                  )}
                </div>
              )}

              {/* 自适应输入框 */}
              <div className="relative w-full">
                <textarea
                  ref={textareaRef}
                  rows={1}
                  value={text}
                  onChange={handleInputChange}
                  onCompositionStart={() => {
                    isComposingRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    setTimeout(() => {
                      isComposingRef.current = false;
                    }, 60);
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    mounted && !isModelConfigured
                      ? "未配置模型，请点击右下角“未配置模型”完成配置"
                      : targetProjectId && isProjectFolderMissing
                      ? "当前项目未关联本地文件夹，关联后方可开始对话"
                      : targetProjectId && localStatus === "NEED_PERMISSION"
                      ? "请先点击上方授权访问关联文件夹后开始对话"
                      : isStreaming
                      ? "助手正在执行... 可随时输入排队指令，或在上方队列点击“引导”立即转向"
                      : currentRunMode === "plan"
                      ? "已启用 @plan 规划模式：描述需求，将先只读分析并产出待审批方案..."
                      : "描述你的需求或任务，输入 @ 召唤规划模式或技能（Enter 发送）"
                  }
                  className="w-full min-h-[38px] max-h-[260px] bg-transparent text-[14.5px] text-white placeholder:text-[#8E8E93] outline-none resize-none leading-relaxed px-2 py-1 font-sans scrollbar-none"
                  style={
                    isOverflowing
                      ? {
                          maskImage:
                            "linear-gradient(to bottom, transparent 0px, black 8px, black calc(100% - 8px), transparent 100%)",
                          WebkitMaskImage:
                            "linear-gradient(to bottom, transparent 0px, black 8px, black calc(100% - 8px), transparent 100%)",
                        }
                      : undefined
                  }
                />
                {isOverflowing && (
                  <>
                    <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-b from-[#2A2A2A]/60 to-transparent pointer-events-none backdrop-blur-[0.5px] rounded-t-lg" />
                    <div className="absolute bottom-0 left-0 right-0 h-2 bg-gradient-to-t from-[#2A2A2A]/60 to-transparent pointer-events-none backdrop-blur-[0.5px] rounded-b-lg" />
                  </>
                )}
              </div>

              {/* 底部工具栏：移除旧 Plan/Act 开关与无功能死按钮，统一为 @ 召唤 + 权限策略 + 上下文 + 模型 */}
              <div className="flex items-center justify-between mt-1.5 pt-0 gap-2">
                {/* 左下操作项 */}
                <div className="flex items-center gap-1.5 min-w-0">
                  {/* @ 召唤模式与技能按钮 */}
                  <button
                    type="button"
                    onClick={handleTriggerMentionButton}
                    className={`h-7 px-2 rounded-lg text-xs flex items-center gap-1 transition-colors cursor-pointer shrink-0 ${
                      mentionOpen || currentRunMode === "plan" || selectedSkill
                        ? "bg-white/[0.1] text-white"
                        : "text-[#989898] hover:text-white hover:bg-white/[0.08]"
                    }`}
                    title="输入 @ 召唤 @plan 规划模式或快捷技能"
                  >
                    <AtSign className="w-3.5 h-3.5 stroke-[2]" />
                    <span className="hidden sm:inline text-[11.5px]">召唤</span>
                  </button>

                  {/* 三档执行权限审批策略下拉 */}
                  <div className="relative" ref={approvalRef}>
                    <button
                      type="button"
                      onClick={() => setIsApprovalOpen(!isApprovalOpen)}
                      className={`h-7 px-2 rounded-lg text-xs flex items-center gap-1.5 transition-colors cursor-pointer ${
                        permissionMode === "review_all"
                          ? "text-amber-300 bg-amber-500/10 hover:bg-amber-500/15 border border-amber-500/25"
                          : "text-[#989898] hover:text-white hover:bg-white/[0.08]"
                      }`}
                      title="设置权限审批粒度（编辑放行 / 标准命令审批 / 全量 Diff 审阅）"
                    >
                      <Hand
                        className={`w-3.5 h-3.5 ${
                          permissionMode === "review_all"
                            ? "text-amber-400"
                            : "text-[#989898]"
                        }`}
                      />
                      <span className="hidden sm:inline">
                        {permissionMode === "accept_edits"
                          ? "编辑放行"
                          : permissionMode === "default"
                          ? "标准审批"
                          : "全量审阅"}
                      </span>
                      <ChevronDown className="w-3 h-3 opacity-70" />
                    </button>

                    {isApprovalOpen && (
                      <div className="absolute bottom-9 left-0 z-50 w-52 py-1 bg-[#1B1B1F] border border-[#2E2E36] rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.6)] text-xs space-y-0.5 animate-in fade-in zoom-in-95 backdrop-blur-xl">
                        <button
                          type="button"
                          onClick={() => {
                            setPermissionMode("accept_edits");
                            setIsApprovalOpen(false);
                          }}
                          className="w-full px-3 py-1.5 flex items-center justify-between text-[#ECECED] hover:bg-white/[0.08] text-left cursor-pointer"
                        >
                          <div>
                            <div>编辑放行（默认）</div>
                            <div className="text-[10px] text-zinc-500">
                              仅高危命令/敏感/删除弹窗
                            </div>
                          </div>
                          {permissionMode === "accept_edits" && (
                            <Check className="w-3.5 h-3.5 text-[#3B82F6] shrink-0" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setPermissionMode("default");
                            setIsApprovalOpen(false);
                          }}
                          className="w-full px-3 py-1.5 flex items-center justify-between text-[#ECECED] hover:bg-white/[0.08] text-left cursor-pointer"
                        >
                          <div>
                            <div>标准命令审批</div>
                            <div className="text-[10px] text-zinc-500">
                              非只读终端命令均需确认
                            </div>
                          </div>
                          {permissionMode === "default" && (
                            <Check className="w-3.5 h-3.5 text-[#3B82F6] shrink-0" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setPermissionMode("review_all");
                            setIsApprovalOpen(false);
                          }}
                          className="w-full px-3 py-1.5 flex items-center justify-between text-amber-200 hover:bg-amber-500/10 text-left cursor-pointer"
                        >
                          <div>
                            <div>全量 Diff 审阅</div>
                            <div className="text-[10px] text-amber-400/70">
                              常规文件写/编辑也弹审批
                            </div>
                          </div>
                          {permissionMode === "review_all" && (
                            <Check className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* 右下操作项 */}
                <div className="flex items-center gap-2 relative shrink-0">
                  {/* 上下文容量计量指示器（面客友好中文提示 + 真实窗口上限） */}
                  {mounted && contextTelemetry && (
                    <div
                      className="hidden md:inline-flex items-center gap-1.5 h-7 px-2 rounded-lg bg-[#1F1F24] border border-white/[0.07] text-[10.5px] font-mono text-zinc-300 select-none"
                      title={[
                        `当前会话上下文占用：${contextTelemetry.total_tokens.toLocaleString()} / ${contextWindowMax.toLocaleString()} tokens (${contextUsagePct}%)`,
                        `上下文缓存加速：${
                          contextTelemetry.prefix_cache_stable ? "已生效" : "预热中"
                        }`,
                        "注：此处为当前对话窗口占用，区别于单轮多步累计 token 消耗",
                      ].join("\n")}
                    >
                      <Gauge
                        className={`w-3 h-3 shrink-0 ${
                          contextUsagePct >= 85
                            ? "text-rose-400"
                            : contextUsagePct >= 60
                            ? "text-amber-400"
                            : "text-emerald-400"
                        }`}
                      />
                      <span>{formatCompactTokens(contextTelemetry.total_tokens)}</span>
                      <span className="text-zinc-500">({contextUsagePct}%)</span>
                    </div>
                  )}

                  {/* 模型选择器 / 未配置模型引导 */}
                  {mounted && !isModelConfigured ? (
                    <button
                      type="button"
                      onClick={() => router.push("/settings?tab=models")}
                      className="h-7 px-2.5 rounded-lg text-xs font-sans text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 flex items-center gap-1.5 transition-colors cursor-pointer group shadow-sm active:scale-95"
                      title="未配置可用模型或 API Key，点击立即前往设置页面配置"
                    >
                      <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0 group-hover:scale-110 transition-transform" />
                      <span className="font-medium whitespace-nowrap">未配置模型</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setIsModelOpen(!isModelOpen)}
                      className="h-7 px-2 rounded-lg text-xs font-sans text-[#E4E4E7] hover:text-white hover:bg-white/[0.08] flex items-center gap-1.5 transition-colors cursor-pointer"
                      title="切换模型与思考深度"
                    >
                      <span suppressHydrationWarning className="font-medium">
                        {formatModelDisplayName(
                          mounted && activeModel ? activeModel.name : "自定义模型"
                        )}
                      </span>
                      <span className="px-1.5 py-0.5 rounded bg-white/[0.06] text-[10px] text-zinc-400">
                        思考·{effortLabel}
                      </span>
                      <ChevronDown className="w-3 h-3 text-[#989898]" />
                    </button>
                  )}

                  <ModelSelectorPopover
                    isOpen={isModelOpen}
                    onClose={() => setIsModelOpen(false)}
                  />

                  {/* 发送 / 终止按钮组 */}
                  <div className="flex items-center gap-1.5">
                    {isStreaming && (
                      <button
                        type="button"
                        onClick={() =>
                          effectiveSessionId && stopGeneration(effectiveSessionId)
                        }
                        className="w-8 h-8 rounded-full bg-[#F43F5E]/20 hover:bg-[#F43F5E]/30 border border-[#F43F5E]/40 text-[#F43F5E] flex items-center justify-center transition-all cursor-pointer shadow-sm active:scale-95"
                        title="停止生成"
                      >
                        <Square className="w-3.5 h-3.5 fill-current" />
                      </button>
                    )}

                    {(!isStreaming || text.trim().length > 0) && (
                      <button
                        type="button"
                        onClick={handleSend}
                        disabled={!isModelConfigured || !text.trim()}
                        className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                          isModelConfigured && text.trim()
                            ? isStreaming
                              ? "bg-[#D97706] hover:bg-[#B45309] text-white shadow-[0_2px_10px_rgba(217,119,6,0.4)] cursor-pointer active:scale-95"
                              : currentRunMode === "plan"
                              ? "bg-indigo-600 hover:bg-indigo-500 text-white shadow-[0_2px_10px_rgba(99,102,241,0.4)] cursor-pointer active:scale-95"
                              : "bg-[#2C67C5] hover:bg-[#255CBA] text-white shadow-[0_2px_10px_rgba(44,103,197,0.4)] cursor-pointer active:scale-95"
                            : "bg-[#38383E] text-[#71717A] cursor-not-allowed opacity-60"
                        }`}
                        title={
                          !isModelConfigured
                            ? "未配置模型，点击前往设置"
                            : isStreaming
                            ? hasPendingConfirmation
                              ? "发送新指令并替换当前确认"
                              : "加入排队队列"
                            : currentRunMode === "plan"
                            ? "以 @plan 规划模式发送"
                            : "发送 (Enter)"
                        }
                      >
                        <ArrowUp className="w-4 h-4 stroke-[2.4]" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
