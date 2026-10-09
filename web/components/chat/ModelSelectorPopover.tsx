"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  ChevronRight,
  Check,
  Settings2,
  Sparkles,
  Zap,
} from "lucide-react";
import { useSessionStore } from "@/stores/useSessionStore";
import { useModelConfigStore } from "@/stores/useModelConfigStore";
import { useRouter } from "next/navigation";

interface ModelSelectorPopoverProps {
  isOpen: boolean;
  onClose: () => void;
}

const REASONING_LEVELS: Array<{ id: "low" | "medium" | "high"; name: string }> = [
  { id: "low", name: "轻度" },
  { id: "medium", name: "中" },
  { id: "high", name: "高" },
];

export function ModelSelectorPopover({
  isOpen,
  onClose,
}: ModelSelectorPopoverProps) {
  const router = useRouter();
  const { reasoningEffort, setReasoningEffort, setSelectedModel } =
    useSessionStore();
  const {
    models,
    activeModelId,
    setActiveModelId,
  } = useModelConfigStore();

  const [subView, setSubView] = useState<"root" | "reasoning">("root");
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node)
      ) {
        if (subView === "reasoning") {
          // 关闭高中低界面，点击外部依然展示之前的模型选择页面
          setSubView("root");
        } else {
          // 在之前的页面点击外部，关闭整个浮层
          onClose();
        }
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (subView === "reasoning") {
          setSubView("root");
        } else {
          onClose();
        }
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose, subView]);

  useEffect(() => {
    if (!isOpen) {
      setSubView("root");
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const currentEffortName =
    REASONING_LEVELS.find((r) => r.id === reasoningEffort)?.name || "高";

  const handleSelectModel = (modelId: string, modelName: string) => {
    setActiveModelId(modelId);
    setSelectedModel(modelName);
    onClose();
  };

  const handleOpenConfigModal = () => {
    onClose();
    router.push("/settings?tab=models");
  };

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-12 right-0 z-50 w-64 py-1.5 bg-[#1B1B1F] border border-[#2C2C33] rounded-xl shadow-2xl text-xs select-none animate-in fade-in zoom-in-95"
    >
      {subView === "root" && (
        <div className="space-y-1">
          {/* 1. 区域标题 */}
          <div className="px-3 py-1.5 text-[11px] font-semibold text-[#8E8E93] flex items-center justify-between border-b border-hairline/60">
            <span className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-white/60" />
              <span>已配置大模型</span>
            </span>
            <span className="text-[10px] text-[#71717A] font-normal font-mono">
              {models.length} 个可用
            </span>
          </div>

          {/* 2. 用户自定义配置的模型列表 */}
          <div className="max-h-48 overflow-y-auto px-1 space-y-0.5">
            {models.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-codex-subtle">
                <p>暂无自定义模型</p>
                <button
                  type="button"
                  onClick={handleOpenConfigModal}
                  className="mt-1 text-xs text-blue-400 hover:text-blue-300 underline cursor-pointer"
                >
                  去添加模型
                </button>
              </div>
            ) : (
              models.map((m) => {
                const isSelected = m.id === activeModelId;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => handleSelectModel(m.id, m.name)}
                    className={`w-full px-2.5 py-2 rounded-lg flex items-center justify-between transition-colors text-left group ${
                      isSelected
                        ? "bg-white/[0.08] text-white"
                        : "text-codex-text hover:bg-white/[0.04]"
                    }`}
                  >
                    <div className="min-w-0 flex-1 pr-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium truncate">{m.name}</span>
                        {m.isDefault && (
                          <span className="px-1 py-0.2 text-[9px] bg-blue-500/20 text-blue-400 rounded font-normal shrink-0">
                            默认
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-[#71717A] truncate mt-0.5 font-mono">
                        {m.modelId}
                      </div>
                    </div>

                    {isSelected && (
                      <Check className="w-4 h-4 text-blue-400 shrink-0" />
                    )}
                  </button>
                );
              })
            )}
          </div>

          <div className="h-[1px] bg-hairline mx-2 my-0.5" />

          {/* 3. 推理强度入口 */}
          <div className="px-1">
            <button
              type="button"
              onClick={() => setSubView("reasoning")}
              className="w-full px-2.5 py-1.5 rounded-lg flex items-center justify-between text-codex-text hover:bg-white/[0.04] transition-colors text-left"
            >
              <div className="flex items-center gap-2">
                <Zap className="w-3.5 h-3.5 text-amber-400/80" />
                <span>推理强度</span>
              </div>
              <div className="flex items-center gap-1 text-codex-muted">
                <span>{currentEffortName}</span>
                <ChevronRight className="w-3.5 h-3.5 text-codex-subtle" />
              </div>
            </button>
          </div>

          <div className="h-[1px] bg-hairline mx-2 my-0.5" />

          {/* 4. 底部常驻按钮：配置模型 */}
          <div className="px-1 pt-0.5">
            <button
              type="button"
              onClick={handleOpenConfigModal}
              className="w-full px-2.5 py-2 rounded-lg flex items-center gap-2 text-white hover:bg-white/[0.08] transition-all text-left font-medium"
            >
              <Settings2 className="w-3.5 h-3.5 text-blue-400" />
              <span>配置模型...</span>
            </button>
          </div>
        </div>
      )}

      {/* 子菜单：仅保留轻度、中、高三个按钮，无多余标题与返回键，点击后直接生效并回到主菜单 */}
      {subView === "reasoning" && (
        <div className="p-1 space-y-0.5">
          {REASONING_LEVELS.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                setReasoningEffort(r.id);
                setSubView("root");
              }}
              className={`w-full px-3 py-2 rounded-lg flex items-center justify-between text-left transition-colors ${
                reasoningEffort === r.id
                  ? "bg-white/[0.08] text-white"
                  : "text-codex-text hover:bg-white/[0.04]"
              }`}
            >
              <span className="font-medium">{r.name}</span>
              {reasoningEffort === r.id && (
                <Check className="w-3.5 h-3.5 text-blue-400" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
