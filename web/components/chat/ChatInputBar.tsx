"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  ArrowUp,
  Plus,
  Hand,
  Mic,
  Square,
  ChevronDown,
  Check,
  AlertCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { ModelSelectorPopover } from "./ModelSelectorPopover";
import { useChatStore } from "@/stores/useChatStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useModelConfigStore } from "@/stores/useModelConfigStore";

interface ChatInputBarProps {
  sessionId?: string | null;
  initialPrompt?: string;
  onSendWithPrompt?: (prompt: string) => void;
  onHeightChange?: (height: number) => void;
  scrollbarWidth?: number;
}

export function ChatInputBar({
  sessionId,
  initialPrompt = "",
  onSendWithPrompt,
  onHeightChange,
  scrollbarWidth = 0,
}: ChatInputBarProps) {
  const router = useRouter();
  const { sendStreamMessage, stopGeneration, isStreaming } = useChatStore();
  const {
    activeProjectId,
    reasoningEffort,
    approvalMode,
    setApprovalMode,
    createSession,
  } = useSessionStore();
  const { getActiveModel } = useModelConfigStore();
  const activeModel = getActiveModel();

  const [text, setText] = useState(initialPrompt);
  const [isModelOpen, setIsModelOpen] = useState(false);
  const [isApprovalOpen, setIsApprovalOpen] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [mounted, setMounted] = useState(false);

  const isModelConfigured = Boolean(
    mounted && activeModel && activeModel.apiKey && activeModel.apiKey.trim().length > 0
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const barContainerRef = useRef<HTMLDivElement>(null);
  const approvalRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);

  // 点击外部或按 Escape 键关闭请求批准弹窗
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

  // 监听输入框区域真实渲染高度，联动消息流垫片与滚动按钮
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

  // 自动弹性调整高度 (最大 260px，超长输入时触发上下玻璃模糊渐隐)
  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = 260;
    const nextHeight = Math.min(Math.max(el.scrollHeight, 38), maxHeight);
    el.style.height = `${nextHeight}px`;
    setIsOverflowing(el.scrollHeight > maxHeight);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    adjustHeight();
  };

  const handleSend = async () => {
    if (!isModelConfigured) {
      router.push("/settings?tab=models");
      return;
    }

    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    setText("");
    setIsOverflowing(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    if (onSendWithPrompt) {
      onSendWithPrompt(trimmed);
      return;
    }

    let targetSessionId = sessionId;
    if (!targetSessionId) {
      // 若当前没有活跃会话，自动创建并转正（默认标题为“新对话”，等待首次提问后 AI 智能自动提炼）
      const newSession = await createSession(
        "新对话",
        activeProjectId || undefined
      );
      targetSessionId = newSession.id;
    }

    sendStreamMessage(targetSessionId, trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 忽略中文输入法候选选词阶段的回车，防止误发送
    if (
      e.nativeEvent.isComposing ||
      isComposingRef.current ||
      e.keyCode === 229
    ) {
      return;
    }

    if (e.key === "Enter") {
      if (e.shiftKey) {
        // Shift + Enter: 保持换行行为，并在下帧动态校准卡片高度
        requestAnimationFrame(() => adjustHeight());
        return;
      }

      // Enter: 发送消息并阻止换行
      e.preventDefault();
      if (!isModelConfigured) {
        router.push("/settings?tab=models");
        return;
      }
      handleSend();
    }
  };

  // 监听外部卡片快捷 Prompt 注入
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
      : "轻度";

  return (
    /* 居底容器：卡片上方 0 空隙，无多余黑色条块，文字直接滑入卡片下方被卡片遮挡 */
    <div
        ref={barContainerRef}
        style={
          scrollbarWidth > 0
            ? { paddingRight: `${scrollbarWidth}px` }
            : undefined
        }
        className="absolute bottom-0 left-0 right-0 z-30 pointer-events-none flex flex-col justify-end"
      >
        {/* 顶部自然过渡柔和渐隐遮罩 */}
        <div className="absolute top-0 h-[24px] left-0 right-0 bg-gradient-to-b from-transparent to-[#161618] pointer-events-none" />
        {/* 底层实色遮罩：严格使用与主页面一致的 #161618，消除对话框两侧空白处的横向色差 */}
        <div className="absolute top-[24px] bottom-0 left-0 right-0 bg-[#161618] pointer-events-none" />

        {/* 输入框主区：仅保留底部安全边距，无任何顶部 padding */}
        <div className="relative z-10 w-full pb-6 px-4 md:px-6 pointer-events-none">
          <div className="max-w-3xl mx-auto relative pointer-events-auto flex flex-col items-start w-full">
            {/* 主输入卡片容器：截图同款 #2A2A2A 质感与圆角，无中部分割线 */}
            <div className="w-full rounded-[20px] border border-[#383838]/60 bg-[#2A2A2A] shadow-[0_12px_36px_rgba(0,0,0,0.55)] p-3 transition-all duration-200 focus-within:border-[#484848] focus-within:ring-1 focus-within:ring-white/[0.08]">
            {/* 自适应输入框容器 (超出滚动时带上下玻璃模糊遮罩) */}
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
                  // 部分浏览器（如 macOS Safari/Chrome）在中文选词确认时，
                  // 会紧接着派发 keydown (Enter)，延时重置可有效拦截误发
                  setTimeout(() => {
                    isComposingRef.current = false;
                  }, 60);
                }}
                onKeyDown={handleKeyDown}
                placeholder={
                  mounted && !isModelConfigured
                    ? "未配置模型，请点击右下角“未配置模型”完成配置"
                    : "随心输入"
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
                  {/* 顶部微弱玻璃模糊遮罩 (调小至 8px 轻微过渡) */}
                  <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-b from-[#2A2A2A]/60 to-transparent pointer-events-none backdrop-blur-[0.5px] rounded-t-lg" />
                  {/* 底部微弱玻璃模糊遮罩 (调小至 8px 轻微过渡) */}
                  <div className="absolute bottom-0 left-0 right-0 h-2 bg-gradient-to-t from-[#2A2A2A]/60 to-transparent pointer-events-none backdrop-blur-[0.5px] rounded-b-lg" />
                </>
              )}
            </div>

            {/* 底部功能工具栏：无任何中部分割线 */}
            <div className="flex items-center justify-between mt-1.5 pt-0">
              {/* 左下操作项 */}
              <div className="flex items-center gap-1.5">
                {/* 附件按钮 */}
                <button
                  type="button"
                  className="w-7 h-7 rounded-lg text-[#989898] hover:text-white hover:bg-white/[0.08] flex items-center justify-center transition-colors cursor-pointer"
                  title="上传附件/上下文"
                >
                  <Plus className="w-4 h-4 stroke-[2]" />
                </button>

                {/* 请求批准按钮 (截图同款 Hand 图标) */}
                <div className="relative" ref={approvalRef}>
                  <button
                    type="button"
                    onClick={() => setIsApprovalOpen(!isApprovalOpen)}
                    className="h-7 px-2 rounded-lg text-xs text-[#989898] hover:text-white hover:bg-white/[0.08] flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Hand className="w-3.5 h-3.5 text-[#989898]" />
                    <span>
                      {approvalMode === "approval"
                        ? "请求批准"
                        : approvalMode === "auto"
                        ? "自动审查"
                        : "完全执行"}
                    </span>
                  </button>

                  {isApprovalOpen && (
                    <div className="absolute bottom-9 left-0 z-50 w-36 py-1 bg-[#1B1B1F] border border-[#2E2E36] rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.6)] text-xs space-y-0.5 animate-in fade-in zoom-in-95 backdrop-blur-xl">
                      <button
                        type="button"
                        onClick={() => {
                          setApprovalMode("approval");
                          setIsApprovalOpen(false);
                        }}
                        className="w-full px-3 py-1.5 flex items-center justify-between text-[#ECECED] hover:bg-white/[0.08] text-left cursor-pointer"
                      >
                        <span>请求批准</span>
                        {approvalMode === "approval" && (
                          <Check className="w-3.5 h-3.5 text-[#3B82F6]" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setApprovalMode("auto");
                          setIsApprovalOpen(false);
                        }}
                        className="w-full px-3 py-1.5 flex items-center justify-between text-[#ECECED] hover:bg-white/[0.08] text-left cursor-pointer"
                      >
                        <span>自动审查</span>
                        {approvalMode === "auto" && (
                          <Check className="w-3.5 h-3.5 text-[#3B82F6]" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setApprovalMode("full");
                          setIsApprovalOpen(false);
                        }}
                        className="w-full px-3 py-1.5 flex items-center justify-between text-[#ECECED] hover:bg-white/[0.08] text-left cursor-pointer"
                      >
                        <span>完全执行</span>
                        {approvalMode === "full" && (
                          <Check className="w-3.5 h-3.5 text-[#3B82F6]" />
                        )}
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* 右下操作项 */}
              <div className="flex items-center gap-2 relative">
                {/* 模型调节气泡入口 / 未配置模型提示 */}
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
                    className="h-7 px-2 rounded-lg text-xs font-sans text-[#E4E4E7] hover:text-white hover:bg-white/[0.08] flex items-center gap-1 transition-colors cursor-pointer"
                  >
                    <span suppressHydrationWarning>
                      {`${mounted && activeModel ? activeModel.name : "自定义"} ${effortLabel}`}
                    </span>
                    <ChevronDown className="w-3 h-3 text-[#989898]" />
                  </button>
                )}

                {/* 模型/推理弹出菜单 */}
                <ModelSelectorPopover
                  isOpen={isModelOpen}
                  onClose={() => setIsModelOpen(false)}
                />

                {/* 麦克风图标 */}
                <button
                  type="button"
                  className="w-7 h-7 rounded-lg text-[#989898] hover:text-white hover:bg-white/[0.08] flex items-center justify-center transition-colors cursor-pointer"
                  title="语音输入"
                >
                  <Mic className="w-4 h-4 stroke-[1.8]" />
                </button>

                {/* 发送 / 终止按钮 (截图同款 #2C67C5 深蓝圆形) */}
                {isStreaming ? (
                  <button
                    type="button"
                    onClick={() => sessionId && stopGeneration(sessionId)}
                    className="w-8 h-8 rounded-full bg-[#F43F5E]/20 hover:bg-[#F43F5E]/30 border border-[#F43F5E]/40 text-[#F43F5E] flex items-center justify-center transition-all cursor-pointer shadow-sm active:scale-95"
                    title="停止生成"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={!isModelConfigured || !text.trim()}
                    className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                      isModelConfigured && text.trim()
                        ? "bg-[#2C67C5] hover:bg-[#255CBA] text-white shadow-[0_2px_10px_rgba(44,103,197,0.4)] cursor-pointer active:scale-95"
                        : "bg-[#38383E] text-[#71717A] cursor-not-allowed opacity-60"
                    }`}
                    title={
                      !isModelConfigured
                        ? "未配置模型，无法发送 (请点击左侧“未配置模型”完成配置)"
                        : "发送 (Enter 发送，Shift + Enter 换行)"
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
  );
}

