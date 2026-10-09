"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useSessionStore } from "@/stores/useSessionStore";

export function DeleteConfirmModal() {
  const router = useRouter();
  const {
    isDeleteModalOpen,
    closeDeleteModal,
    confirmDelete,
    deleteModalSessionId,
    sessions,
    activeSessionId,
  } = useSessionStore();

  const targetSession = sessions.find((s) => s.id === deleteModalSessionId);

  const handleConfirm = async () => {
    if (!deleteModalSessionId) return;
    const isCurrentActive = activeSessionId === deleteModalSessionId;
    const remaining = sessions.filter(
      (s) => s.id !== deleteModalSessionId && !s.is_archived
    );
    const nextActiveId = isCurrentActive
      ? remaining.length > 0
        ? remaining[0].id
        : null
      : null;

    await confirmDelete();

    if (isCurrentActive) {
      if (nextActiveId) {
        router.push(`/chat/${nextActiveId}`);
      } else {
        router.push("/chat");
      }
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isDeleteModalOpen) return;
      if (e.key === "Escape") {
        closeDeleteModal();
      } else if (e.key === "Enter") {
        handleConfirm();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isDeleteModalOpen, closeDeleteModal, handleConfirm]);

  if (!isDeleteModalOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={closeDeleteModal}
    >
      <div
        className="w-[320px] bg-elevated border border-hairline rounded-xl p-5 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150 select-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-accent-coral/15 border border-accent-coral/30 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-4 h-4 text-accent-coral" />
          </div>
          <div>
            <h3 className="text-sm font-medium text-genesis-primary">
              确定删除该会话？
            </h3>
            {targetSession && (
              <p className="text-xs text-genesis-secondary mt-1 truncate max-w-[220px]">
                “{targetSession.title}”
              </p>
            )}
          </div>
        </div>

        <p className="text-xs text-genesis-muted leading-relaxed">
          此操作将永久抹除该会话下的所有历史记录与生成产物，无法撤销。
        </p>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={closeDeleteModal}
            className="px-3 py-1.5 rounded-md text-xs text-genesis-secondary hover:text-genesis-primary hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent-coral/20 border border-accent-coral/40 text-accent-coral hover:bg-accent-coral/30 flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>确认删除</span>
          </button>
        </div>
      </div>
    </div>
  );
}

