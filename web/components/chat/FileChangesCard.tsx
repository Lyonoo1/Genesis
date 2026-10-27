"use client";

import React, { useState } from "react";
import {
  FileCode2,
  ArrowUpRight,
  Undo2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Check,
} from "lucide-react";
import { DiffFileItem, useWorkbenchStore } from "@/stores/useWorkbenchStore";
import { useUIStore } from "@/stores/useUIStore";
import { revertFilesApi } from "@/lib/api/chat";

interface FileChangesCardProps {
  files: DiffFileItem[];
  sessionId?: string;
}

export function FileChangesCard({ files, sessionId }: FileChangesCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isReverting, setIsReverting] = useState(false);
  const [isReverted, setIsReverted] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const confirmTimerRef = React.useRef<NodeJS.Timeout | null>(null);

  const { openChangesTab, triggerPreviewReload, removeFileDiff } = useWorkbenchStore();
  const { openRightSidebar } = useUIStore();

  if (!files || files.length === 0) return null;

  const totalAdditions = files.reduce((acc, f) => acc + f.additions, 0);
  const totalDeletions = files.reduce((acc, f) => acc + f.deletions, 0);

  // 默认最多展示前 3 个文件，更多需展开
  const visibleFiles = isExpanded ? files : files.slice(0, 3);
  const remainingCount = files.length - 3;

  // 点击查看变更：在工作台打开变更 Tab 并激活
  const handleOpenChanges = (selectedFilePath?: string) => {
    openChangesTab(
      {
        diffFiles: files,
        selectedFilePath: selectedFilePath || files[0]?.path,
      },
      true,
      sessionId
    );
    openRightSidebar();
  };

  // 点击撤销本轮修改 (双重确认防止误触)
  const handleRevertClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isReverting || isReverted) return;

    if (!confirmRevert) {
      setConfirmRevert(true);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => {
        setConfirmRevert(false);
      }, 3000);
      return;
    }

    // 第二次点击，执行撤销
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmRevert(false);
    executeRevert();
  };

  const executeRevert = async () => {
    setIsReverting(true);
    try {
      const payload = files.map((f) => ({
        path: f.path,
        original_content: f.originalContent || "",
      }));
      const res = await revertFilesApi(payload, sessionId);
      if (res && res.success) {
        setIsReverted(true);
        removeFileDiff(files.map((f) => f.path), sessionId);
        triggerPreviewReload();
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("genesis:workspace-refresh"));
        }
      }
    } catch (err) {
      console.error("[FileChangesCard] Failed to revert changes:", err);
    } finally {
      setIsReverting(false);
    }
  };

  // --- 分级展示 1：单文件紧凑胶囊 (36px Compact Pill) ---
  if (files.length === 1) {
    const singleFile = files[0];
    return (
      <div className="my-2 w-full h-9 px-3 rounded-lg bg-[#1E1E20] hover:bg-[#242427] border border-white/[0.08] flex items-center justify-between text-xs text-[#ECECED] select-none transition-all shadow-sm">
        {/* 左侧：文件图标 + 路径 + 增删统计 */}
        <div
          onClick={() => handleOpenChanges(singleFile.path)}
          className="flex items-center gap-2 min-w-0 cursor-pointer group"
          title={`查看 ${singleFile.path} 变更`}
        >
          <FileCode2 className="w-3.5 h-3.5 text-zinc-400 group-hover:text-white transition-colors shrink-0 stroke-[1.8]" />
          <span
            className={`font-mono truncate max-w-[240px] sm:max-w-[360px] transition-colors ${
              isReverted
                ? "text-zinc-500 line-through"
                : "text-zinc-200 group-hover:text-white"
            }`}
          >
            {singleFile.name || singleFile.path}
          </span>
          <div className="flex items-center gap-1 font-mono text-[11px] shrink-0">
            {singleFile.additions > 0 && (
              <span className="text-emerald-400">+{singleFile.additions}</span>
            )}
            {singleFile.deletions > 0 && (
              <span className="text-rose-400">-{singleFile.deletions}</span>
            )}
          </div>
        </div>

        {/* 右侧：撤销与审查入口 */}
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={handleRevertClick}
            disabled={isReverting || isReverted}
            className={`flex items-center gap-1 text-[11px] transition-colors cursor-pointer px-1.5 py-0.5 rounded ${
              isReverted
                ? "text-emerald-400 cursor-default"
                : confirmRevert
                ? "bg-rose-500/20 text-rose-300 font-medium animate-pulse"
                : "text-zinc-400 hover:text-white hover:bg-white/[0.06]"
            }`}
            title={confirmRevert ? "点击确认执行撤销" : "撤销本文件修改"}
          >
            {isReverting ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : isReverted ? (
              <Check className="w-3 h-3 text-emerald-400" />
            ) : (
              <Undo2 className="w-3 h-3" />
            )}
            <span>
              {isReverting
                ? "撤销中"
                : isReverted
                ? "已撤销"
                : confirmRevert
                ? "确认撤销?"
                : "撤销"}
            </span>
          </button>

          {!isReverted && (
            <button
              type="button"
              onClick={() => handleOpenChanges(singleFile.path)}
              className="flex items-center gap-1 text-[11px] text-zinc-300 hover:text-white hover:bg-white/[0.08] px-2 py-0.5 rounded transition-colors cursor-pointer group"
            >
              <span>审查</span>
              <ArrowUpRight className="w-3 h-3 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
            </button>
          )}
        </div>
      </div>
    );
  }

  // --- 分级展示 2：多文件聚合 Changeset 卡片 ---
  return (
    <div className="my-2.5 w-full rounded-xl border border-white/[0.08] bg-[#1E1E20] p-3 text-[#ECECED] shadow-sm select-none transition-all">
      {/* 1. 顶部 Header (图标、标题、副链接与操作项) */}
      <div className="flex items-center justify-between gap-3">
        {/* 左侧：方形文件图标 + 标题/副链接 */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-[#2B2B2E] border border-white/[0.06] flex items-center justify-center text-[#ECECED] shrink-0">
            <FileCode2 className="w-4 h-4 text-[#C4C4C8] stroke-[1.8]" />
          </div>

          <div className="flex flex-col min-w-0">
            <div className="text-[13px] font-medium text-white flex items-center gap-2 truncate">
              <span>
                {isReverted
                  ? `已撤销 ${files.length} 个文件的变更`
                  : `已编辑 ${files.length} 个文件`}
              </span>
              <div className="flex items-center gap-1 font-mono text-[11px]">
                {totalAdditions > 0 && (
                  <span className="text-emerald-400">+{totalAdditions}</span>
                )}
                {totalDeletions > 0 && (
                  <span className="text-rose-400">-{totalDeletions}</span>
                )}
              </div>
            </div>
            {!isReverted && (
              <button
                type="button"
                onClick={() => handleOpenChanges()}
                className="text-xs text-[#8E8E93] hover:text-white flex items-center gap-0.5 transition-colors cursor-pointer text-left w-fit group"
              >
                <span>查看全部变更</span>
                <ArrowUpRight className="w-3 h-3 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
              </button>
            )}
          </div>
        </div>

        {/* 右侧：撤销按钮 + 查看变更胶囊按钮 */}
        <div className="flex items-center gap-3 shrink-0">
          {/* 撤销按钮 */}
          <button
            type="button"
            onClick={handleRevertClick}
            disabled={isReverting || isReverted}
            className={`flex items-center gap-1.5 text-xs transition-colors cursor-pointer px-2 py-1 rounded ${
              isReverted
                ? "text-emerald-400 cursor-default"
                : confirmRevert
                ? "bg-rose-500/20 text-rose-300 font-medium animate-pulse"
                : "text-[#8E8E93] hover:text-white hover:bg-white/[0.06]"
            }`}
            title={confirmRevert ? "再次点击确认撤销" : "撤销本轮文件变更"}
          >
            {isReverting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : isReverted ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Undo2 className="w-3.5 h-3.5 stroke-[1.8]" />
            )}
            <span>
              {isReverting
                ? "撤销中"
                : isReverted
                ? "已撤销"
                : confirmRevert
                ? "确认撤销?"
                : "撤销"}
            </span>
          </button>

          {/* 查看变更胶囊按钮 */}
          <button
            type="button"
            onClick={() => handleOpenChanges()}
            className="flex items-center px-3 py-1.5 rounded-lg bg-[#2D2D30] hover:bg-[#38383D] active:scale-95 text-xs font-medium text-[#ECECED] hover:text-white border border-white/10 transition-all cursor-pointer shadow-sm"
          >
            <span>查看变更</span>
          </button>
        </div>
      </div>

      {/* 2. 中部文件变更明细列表 (带水平分割线) */}
      <div className="mt-2.5 pt-2 border-t border-white/[0.06] space-y-1">
        {visibleFiles.map((file) => (
          <div
            key={file.path}
            onClick={() => handleOpenChanges(file.path)}
            className="flex items-center justify-between py-1 px-1.5 rounded-md hover:bg-white/[0.04] cursor-pointer group transition-colors"
            title={`点击在工作台查看 ${file.path} 的变更`}
          >
            {/* 左侧：文件路径 */}
            <span
              className={`font-mono text-xs truncate pr-3 select-all transition-colors ${
                isReverted
                  ? "text-[#8E8E93] line-through"
                  : "text-[#C4C4C8] group-hover:text-white"
              }`}
            >
              {file.path}
            </span>

            {/* 右侧：增删行数统计 (+24 -7) */}
            <div className="flex items-center shrink-0 font-mono text-xs font-medium">
              {file.additions > 0 && (
                <span className="text-[#22C55E] mr-1.5">
                  +{file.additions}
                </span>
              )}
              {file.deletions > 0 && (
                <span className="text-[#EF4444]">
                  -{file.deletions}
                </span>
              )}
              {file.additions === 0 && file.deletions === 0 && (
                <span className="text-[#8E8E93]">0</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 3. 底部展开 / 折叠超长文件列表 */}
      {remainingCount > 0 && (
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="mt-1 pt-1.5 flex items-center gap-1 text-xs text-[#8E8E93] hover:text-white transition-colors cursor-pointer w-full text-left"
        >
          <span>
            {isExpanded ? "收起文件" : `再显示 ${remainingCount} 个文件`}
          </span>
          {isExpanded ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
        </button>
      )}
    </div>
  );
}
