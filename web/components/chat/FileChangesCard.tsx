"use client";

import React, { useState, useMemo } from "react";
import {
  FileCode2,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  RotateCcw,
  Clock,
} from "lucide-react";
import { DiffFileItem, useWorkbenchStore } from "@/stores/useWorkbenchStore";
import { useUIStore } from "@/stores/useUIStore";
import { DiffReviewBar } from "@/components/workbench/DiffReviewBar";

interface FileChangesCardProps {
  files: DiffFileItem[];
  sessionId?: string;
}

const EMPTY_DIFF_FILES: DiffFileItem[] = [];

export function FileChangesCard({ files, sessionId }: FileChangesCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const { openChangesTab } = useWorkbenchStore();
  const storeDiffFiles = useWorkbenchStore((s) => {
    const sid = sessionId || s.activeSessionId;
    if (!sid) return s.allDiffFiles || EMPTY_DIFF_FILES;
    const sessionData = s.workbenchBySession[sid];
    if (sessionData) return sessionData.allDiffFiles || EMPTY_DIFF_FILES;
    return sid === s.activeSessionId ? s.allDiffFiles || EMPTY_DIFF_FILES : EMPTY_DIFF_FILES;
  });
  const { openRightSidebar } = useUIStore();

  // 将消息中提取的变更与工作台 Store 中的实时审查状态 / patchId 合并
  const mergedFiles = useMemo(() => {
    if (!files || files.length === 0) return [];
    return files.map((f) => {
      const latest = storeDiffFiles.find((sf) => sf.path === f.path);
      if (!latest) return f;
      return {
        ...f,
        patchId: latest.patchId || latest.patch_id || f.patchId || f.patch_id,
        patch_id: latest.patch_id || latest.patchId || f.patch_id || f.patchId,
        status: latest.status || f.status || "pending",
      };
    });
  }, [files, storeDiffFiles]);

  if (!mergedFiles || mergedFiles.length === 0) return null;

  const totalAdditions = mergedFiles.reduce((acc, f) => acc + f.additions, 0);
  const totalDeletions = mergedFiles.reduce((acc, f) => acc + f.deletions, 0);
  const allReverted = mergedFiles.every((f) => f.status === "rejected");

  // 默认最多展示前 3 个文件，更多需展开
  const visibleFiles = isExpanded ? mergedFiles : mergedFiles.slice(0, 3);
  const remainingCount = mergedFiles.length - 3;

  // 点击查看变更：在工作台打开变更 Tab 并激活
  const handleOpenChanges = (selectedFilePath?: string) => {
    openChangesTab(
      {
        diffFiles: mergedFiles,
        selectedFilePath: selectedFilePath || mergedFiles[0]?.path,
      },
      true,
      sessionId
    );
    openRightSidebar();
  };

  // --- 分级展示 1：单文件紧凑卡片 (集成 DiffReviewBar 事务审查) ---
  if (mergedFiles.length === 1) {
    const singleFile = mergedFiles[0];
    const isReverted = singleFile.status === "rejected";
    return (
      <div className="my-2 w-full rounded-xl bg-[#1E1E20] border border-white/[0.08] overflow-hidden text-xs text-[#ECECED] select-none transition-all shadow-sm">
        <div className="h-9 px-3 flex items-center justify-between hover:bg-[#242427] transition-colors">
          <div
            onClick={() => handleOpenChanges(singleFile.path)}
            className="flex items-center gap-2 min-w-0 cursor-pointer group"
            title={`查看 ${singleFile.path} 变更`}
          >
            <FileCode2 className="w-3.5 h-3.5 text-zinc-400 group-hover:text-white transition-colors shrink-0 stroke-[1.8]" />
            <span
              className={`font-mono truncate max-w-[220px] sm:max-w-[340px] transition-colors ${
                isReverted
                  ? "text-zinc-500 line-through"
                  : "text-zinc-200 group-hover:text-white"
              }`}
            >
              {singleFile.name || singleFile.path}
            </span>
          </div>

          <button
            type="button"
            onClick={() => handleOpenChanges(singleFile.path)}
            className="flex items-center gap-1 text-[11px] text-zinc-300 hover:text-white hover:bg-white/[0.08] px-2 py-0.5 rounded transition-colors cursor-pointer group shrink-0"
          >
            <span>在右侧审查</span>
            <ArrowUpRight className="w-3 h-3 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
          </button>
        </div>

        {/* 嵌入双向 Diff 事务审查条 */}
        <DiffReviewBar
          file={singleFile}
          sessionId={sessionId}
          compact={true}
          className="border-t border-white/[0.06] border-b-0 bg-[#17171B]"
        />
      </div>
    );
  }

  // --- 分级展示 2：多文件聚合 Changeset 卡片 ---
  return (
    <div className="my-2.5 w-full rounded-xl border border-white/[0.08] bg-[#1E1E20] overflow-hidden text-[#ECECED] shadow-sm select-none transition-all">
      <div className="p-3">
        {/* 1. 顶部 Header (图标、标题、副链接与操作项) */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-[#2B2B2E] border border-white/[0.06] flex items-center justify-center text-[#ECECED] shrink-0">
              <FileCode2 className="w-4 h-4 text-[#C4C4C8] stroke-[1.8]" />
            </div>

            <div className="flex flex-col min-w-0">
              <div className="text-[13px] font-medium text-white flex items-center gap-2 truncate">
                <span>
                  {allReverted
                    ? `已回滚 ${mergedFiles.length} 个文件的变更`
                    : `已编辑 ${mergedFiles.length} 个文件`}
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
              {!allReverted && (
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

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => handleOpenChanges()}
              className="flex items-center px-3 py-1.5 rounded-lg bg-[#2D2D30] hover:bg-[#38383D] active:scale-95 text-xs font-medium text-[#ECECED] hover:text-white border border-white/10 transition-all cursor-pointer shadow-sm"
            >
              <span>查看变更</span>
            </button>
          </div>
        </div>

        {/* 2. 中部文件变更明细列表 (带审查状态徽标) */}
        <div className="mt-2.5 pt-2 border-t border-white/[0.06] space-y-1">
          {visibleFiles.map((file) => {
            const isFileReverted = file.status === "rejected";
            const isFileAccepted = file.status === "accepted";
            return (
              <div
                key={file.path}
                onClick={() => handleOpenChanges(file.path)}
                className="flex items-center justify-between py-1 px-1.5 rounded-md hover:bg-white/[0.04] cursor-pointer group transition-colors gap-2"
                title={`点击在工作台查看 ${file.path} 的变更`}
              >
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  {isFileAccepted ? (
                    <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                  ) : isFileReverted ? (
                    <RotateCcw className="w-3 h-3 text-rose-400 shrink-0" />
                  ) : (
                    <Clock className="w-3 h-3 text-amber-400 shrink-0" />
                  )}
                  <span
                    className={`font-mono text-xs truncate select-all transition-colors ${
                      isFileReverted
                        ? "text-[#8E8E93] line-through"
                        : "text-[#C4C4C8] group-hover:text-white"
                    }`}
                  >
                    {file.path}
                  </span>
                </div>

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
            );
          })}
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

      {/* 4. 底部批量 Diff 事务审查条 */}
      <DiffReviewBar
        files={mergedFiles}
        sessionId={sessionId}
        compact={true}
        className="border-t border-white/[0.06] border-b-0 bg-[#17171B]"
      />
    </div>
  );
}
