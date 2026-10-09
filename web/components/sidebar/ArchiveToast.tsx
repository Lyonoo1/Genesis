"use client";

import React, { useEffect } from "react";
import { Archive, X } from "lucide-react";
import { useSessionStore } from "@/stores/useSessionStore";
import { useSettingsStore } from "@/stores/useSettingsStore";

export function ArchiveToast() {
  const {
    archiveToast,
    hideArchiveToast,
    undoArchive,
  } = useSessionStore();
  const { openSettingsModal } = useSettingsStore();

  useEffect(() => {
    if (archiveToast?.visible) {
      const timer = setTimeout(() => {
        hideArchiveToast();
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [archiveToast, hideArchiveToast]);

  if (!archiveToast?.visible) return null;

  const isSession = archiveToast.type === "session";
  const label = isSession ? "已归档的聊天" : "已归档的项目";

  const handleView = () => {
    hideArchiveToast();
    openSettingsModal("archived");
  };

  const handleUndo = async () => {
    await undoArchive();
  };

  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[1100] animate-in fade-in slide-in-from-top-4 duration-200 select-none">
      <div className="flex items-center gap-3 px-3.5 py-2 rounded-2xl bg-[#232326] border border-[#3A3A3F] shadow-2xl backdrop-blur-md">
        {/* 左侧抽屉图标 */}
        <div className="w-5 h-5 rounded-md bg-white/[0.08] flex items-center justify-center shrink-0">
          <Archive className="w-3.5 h-3.5 text-white stroke-[1.8]" />
        </div>

        {/* 提示文案 */}
        <span className="text-xs font-medium text-white tracking-tight">
          {label}
        </span>

        {/* 右侧操作按钮组 */}
        <div className="flex items-center gap-1.5 ml-1">
          <button
            type="button"
            onClick={handleView}
            className="px-2.5 py-1 rounded-xl text-xs text-[#ECECED] bg-white/[0.08] hover:bg-white/[0.14] transition-colors cursor-pointer"
          >
            查看
          </button>
          <button
            type="button"
            onClick={handleUndo}
            className="px-3 py-1 rounded-xl text-xs font-medium text-black bg-white hover:bg-gray-100 transition-colors cursor-pointer active:scale-95 shadow-sm"
          >
            撤销
          </button>
          <button
            type="button"
            onClick={hideArchiveToast}
            className="p-1 rounded-md text-[#8E8E93] hover:text-white transition-colors cursor-pointer ml-0.5"
            title="关闭提示"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
