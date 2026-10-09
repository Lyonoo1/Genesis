"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useSessionStore } from "@/stores/useSessionStore";

export function DeleteProjectModal() {
  const router = useRouter();
  const {
    deleteModalProjectId,
    closeDeleteProjectModal,
    confirmDeleteProject,
    projects,
    sessions,
    activeSessionId,
  } = useSessionStore();

  const isOpen = !!deleteModalProjectId;
  const targetProject = projects.find((p) => p.id === deleteModalProjectId);

  const handleConfirm = async () => {
    if (!deleteModalProjectId) return;
    const targetId = deleteModalProjectId;

    // 检查当前活跃会话是否归属于被删除的项目
    const currentSess = sessions.find((s) => s.id === activeSessionId);
    const isCurrentInProject = currentSess?.project_id === targetId;

    await confirmDeleteProject();

    if (isCurrentInProject) {
      const remaining = sessions.filter(
        (s) => s.project_id !== targetId && !s.is_archived
      );
      router.push(remaining.length > 0 ? `/chat/${remaining[0].id}` : "/chat");
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "Escape") {
        closeDeleteProjectModal();
      } else if (e.key === "Enter") {
        handleConfirm();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closeDeleteProjectModal, handleConfirm]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={closeDeleteProjectModal}
    >
      <div
        className="w-[340px] bg-[#222225] border border-[#333338] rounded-2xl p-5 shadow-2xl space-y-4 animate-in zoom-in-95 duration-150 select-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-xl bg-accent-coral/15 border border-accent-coral/30 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-4 h-4 text-accent-coral" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white">
              确定删除该项目？
            </h3>
            {targetProject && (
              <p className="text-xs text-[#ECECED] mt-1 truncate max-w-[240px]">
                “{targetProject.name}”
              </p>
            )}
          </div>
        </div>

        <p className="text-xs text-[#8E8E93] leading-relaxed">
          此操作将永久抹除该项目及其数据库记录，无法撤销。
        </p>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={closeDeleteProjectModal}
            className="px-3 py-1.5 rounded-lg text-xs text-[#ECECED] hover:bg-white/[0.06] transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-accent-coral/20 border border-accent-coral/40 text-accent-coral hover:bg-accent-coral/30 flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>确认删除</span>
          </button>
        </div>
      </div>
    </div>
  );
}
