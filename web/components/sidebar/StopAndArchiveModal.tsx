"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { useSessionStore } from "@/stores/useSessionStore";
import { useChatStore } from "@/stores/useChatStore";

export function StopAndArchiveModal() {
  const router = useRouter();
  const {
    stopAndArchiveModalSessionId,
    closeStopAndArchiveModal,
    archiveSession,
    sessions,
    activeSessionId,
    showArchiveToast,
  } = useSessionStore();

  const { isStreaming, streamingSessionId, stopGeneration } = useChatStore();

  const isOpen = !!stopAndArchiveModalSessionId;
  const targetSession = sessions.find((s) => s.id === stopAndArchiveModalSessionId);

  const handleConfirm = async () => {
    if (!stopAndArchiveModalSessionId) return;
    const targetId = stopAndArchiveModalSessionId;
    const targetTitle = targetSession?.title || "会话";

    // 1. 如果正在流式响应，停止生成
    if (isStreaming && streamingSessionId === targetId) {
      await stopGeneration(targetId);
    }

    // 2. 归档会话
    const isCurrentActive = activeSessionId === targetId;
    const remaining = sessions.filter(
      (s) => s.id !== targetId && !s.is_archived
    );
    const nextActiveId = isCurrentActive
      ? remaining.length > 0
        ? remaining[0].id
        : null
      : null;

    await archiveSession(targetId);
    closeStopAndArchiveModal();

    // 3. 路由重定向
    if (isCurrentActive) {
      if (nextActiveId) {
        router.push(`/chat/${nextActiveId}`);
      } else {
        router.push("/chat");
      }
    }

    // 4. 展示右下角/底部撤销 Toast
    showArchiveToast("session", targetId, targetTitle);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "Escape") {
        closeStopAndArchiveModal();
      } else if (e.key === "Enter") {
        handleConfirm();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closeStopAndArchiveModal, handleConfirm]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={closeStopAndArchiveModal}
    >
      <div
        className="w-[420px] max-w-[95vw] bg-[#222225] border border-[#333338] rounded-2xl p-6 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150 select-none relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 右上角关闭 X 图标 */}
        <button
          type="button"
          onClick={closeStopAndArchiveModal}
          className="absolute top-5 right-5 p-1 rounded-md text-[#8E8E93] hover:text-white transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        {/* 标题 */}
        <h3 className="text-[17px] font-semibold text-white tracking-tight">
          停止并归档此聊天？
        </h3>

        {/* 描述内容 */}
        <p className="text-[13px] text-[#A1A1A6] leading-relaxed pr-2">
          归档会停止所有正在进行的工作。你可以稍后在设置中恢复该聊天。
        </p>

        {/* 底部按钮操作组 */}
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={closeStopAndArchiveModal}
            className="px-4 py-2 rounded-xl text-xs font-medium text-[#ECECED] bg-[#323236] hover:bg-[#3E3E43] transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-4 py-2 rounded-xl text-xs font-medium bg-[#3D2527] border border-[#582A2E] text-[#FF5555] hover:bg-[#4E2B2E] transition-all cursor-pointer active:scale-95"
          >
            停止并归档
          </button>
        </div>
      </div>
    </div>
  );
}
