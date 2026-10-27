"use client";

import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  ChevronDown,
  Search,
  X,
  ExternalLink,
  Copy,
  Check,
  GitCompare,
  Undo2,
  Loader2,
  Columns2,
  Rows2,
} from "lucide-react";
import {
  useWorkbenchStore,
  DiffFileItem,
  ChangesTabConfig,
} from "@/stores/useWorkbenchStore";
import { useCanvasStore } from "@/stores/useCanvasStore";
import { MonacoDiffEditor } from "@/components/canvas/MonacoDiffEditor";
import { revertFilesApi } from "@/lib/api/chat";

export interface ChangesTabViewProps {
  turnIndex?: number;
  totalAdditions?: number;
  totalDeletions?: number;
  diffFiles?: DiffFileItem[];
  selectedFilePath?: string | null;
}

function getFileLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "html":
    case "vue":
      return "html";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "py":
      return "python";
    case "md":
      return "markdown";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "sql":
      return "sql";
    case "yml":
    case "yaml":
      return "yaml";
    default:
      return "plaintext";
  }
}

export function ChangesTabView({
  turnIndex = 1,
  totalAdditions,
  totalDeletions,
  diffFiles,
  selectedFilePath,
}: ChangesTabViewProps) {
  const { openFileInExplorer, removeFileDiff, triggerPreviewReload } =
    useWorkbenchStore();
  const { customWidthPx } = useCanvasStore();

  const storeChangesTab = useWorkbenchStore((s) =>
    s.tabs.find((t) => t.kind === "changes")
  ) as ChangesTabConfig | undefined;

  const effectiveFiles =
    diffFiles && diffFiles.length > 0
      ? diffFiles
      : storeChangesTab?.diffFiles && storeChangesTab.diffFiles.length > 0
      ? storeChangesTab.diffFiles
      : [];

  const isCompact = (customWidthPx || 260) < 650;
  const [compactView, setCompactView] = useState<"diff" | "list">("diff");
  const [userDiffLayout, setUserDiffLayout] = useState<"split" | "inline" | null>(
    null
  );
  const diffLayout = userDiffLayout ?? (isCompact ? "inline" : "split");

  const [activePath, setActivePath] = useState<string>(
    selectedFilePath ||
      storeChangesTab?.selectedFilePath ||
      effectiveFiles[0]?.path ||
      ""
  );
  const prevPropPathRef = useRef<string | null>(selectedFilePath || null);
  const [filterQuery, setFilterQuery] = useState("");
  const [isCopied, setIsCopied] = useState(false);
  const [isReverting, setIsReverting] = useState(false);

  const handleRevertFile = async (file: DiffFileItem) => {
    if (!file || isReverting) return;
    setIsReverting(true);
    try {
      const payload = [
        {
          path: file.path,
          original_content: file.originalContent || "",
        },
      ];
      const res = await revertFilesApi(payload);
      if (res && res.success) {
        removeFileDiff([file.path]);
        triggerPreviewReload();
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("genesis:workspace-refresh"));
        }
      }
    } catch (err) {
      console.error("[ChangesTabView] Failed to revert file:", err);
    } finally {
      setIsReverting(false);
    }
  };

  const handleRevertAll = async () => {
    if (isReverting || effectiveFiles.length === 0) return;
    setIsReverting(true);
    try {
      const payload = effectiveFiles.map((f) => ({
        path: f.path,
        original_content: f.originalContent || "",
      }));
      const res = await revertFilesApi(payload);
      if (res && res.success) {
        removeFileDiff(effectiveFiles.map((f) => f.path));
        triggerPreviewReload();
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("genesis:workspace-refresh"));
        }
      }
    } catch (err) {
      console.error("[ChangesTabView] Failed to revert all files:", err);
    } finally {
      setIsReverting(false);
    }
  };

  useEffect(() => {
    if (selectedFilePath && selectedFilePath !== prevPropPathRef.current) {
      prevPropPathRef.current = selectedFilePath;
      setActivePath(selectedFilePath);
    }
  }, [selectedFilePath]);

  useEffect(() => {
    if (
      effectiveFiles.length > 0 &&
      !effectiveFiles.some((f) => f.path === activePath)
    ) {
      setActivePath(effectiveFiles[0].path);
    }
  }, [effectiveFiles, activePath]);

  const activeFile = useMemo(() => {
    return (
      effectiveFiles.find((f) => f.path === activePath) || effectiveFiles[0]
    );
  }, [effectiveFiles, activePath]);

  // 计算增删总数
  const sumAdd =
    totalAdditions ||
    storeChangesTab?.totalAdditions ||
    effectiveFiles.reduce((acc, f) => acc + f.additions, 0);
  const sumDel =
    totalDeletions ||
    storeChangesTab?.totalDeletions ||
    effectiveFiles.reduce((acc, f) => acc + f.deletions, 0);

  const filteredTreeFiles = useMemo(() => {
    if (!filterQuery.trim()) return effectiveFiles;
    const q = filterQuery.toLowerCase();
    return effectiveFiles.filter(
      (f) =>
        f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
    );
  }, [effectiveFiles, filterQuery]);

  const handleCopyCurrentDiff = async () => {
    if (!activeFile) return;
    try {
      await navigator.clipboard.writeText(
        activeFile.modifiedContent || activeFile.unifiedDiff || ""
      );
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1500);
    } catch {}
  };

  // 1. 无变更时的干净空状态
  if (effectiveFiles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center w-full h-full bg-[#161618] text-[#ECECED] select-none p-6 gap-3">
        <div className="w-12 h-12 rounded-2xl bg-white/[0.04] border border-white/5 flex items-center justify-center">
          <GitCompare className="w-6 h-6 text-zinc-500 stroke-[1.5]" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-zinc-300">暂无代码变更记录</p>
          <p className="text-xs text-zinc-500 mt-1 max-w-[280px]">
            当智能体编辑或创建工作区文件时，此处将实时展示 Monaco 语法高亮差异对比
          </p>
        </div>
      </div>
    );
  }

  // 差异代码主舞台 (接入 MonacoDiffEditor)
  const renderDiffStage = (isFullWidth: boolean) => (
    <div
      className={`${
        isFullWidth ? "w-full" : "flex-1 border-r border-[#26262A]"
      } flex flex-col min-w-0 h-full`}
    >
      {/* 顶部轮次选择与总计条 */}
      <div className="h-10 px-3 bg-[#18181A] border-b border-[#26262A] flex items-center justify-between shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#222226] text-xs text-white border border-white/10 font-medium">
            <span>
              {turnIndex && turnIndex > 1 ? `第 ${turnIndex} 轮` : "本轮修改"}
            </span>
          </div>
          <span className="text-xs font-mono font-medium text-emerald-400">
            +{sumAdd}
          </span>
          <span className="text-xs font-mono font-medium text-rose-400">
            -{sumDel}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0 text-[#8E8E93]">
          {/* 布局切换 (并排 Split / 行内 Inline) */}
          <button
            type="button"
            onClick={() =>
              setUserDiffLayout(diffLayout === "split" ? "inline" : "split")
            }
            className="flex items-center gap-1 px-2 py-1 rounded bg-[#222226] hover:bg-[#2B2B30] text-[#ECECED] hover:text-white border border-white/10 text-xs transition-colors cursor-pointer"
            title={
              diffLayout === "split"
                ? "当前为并排比对，点击切换为单列行内比对"
                : "当前为行内比对，点击切换为并排比对"
            }
          >
            {diffLayout === "split" ? (
              <Columns2 className="w-3.5 h-3.5 text-sky-400" />
            ) : (
              <Rows2 className="w-3.5 h-3.5 text-sky-400" />
            )}
            <span className="text-[11px] hidden sm:inline">
              {diffLayout === "split" ? "并排" : "行内"}
            </span>
          </button>

          {/* 紧凑模式下切换回变更文件列表 */}
          {isCompact && (
            <button
              type="button"
              onClick={() => setCompactView("list")}
              className="flex items-center gap-1 px-2 py-1 rounded bg-[#222226] hover:bg-[#2B2B30] text-[#ECECED] hover:text-white border border-white/10 text-xs transition-colors shrink-0 cursor-pointer"
              title="查看变更文件列表"
            >
              <GitCompare className="w-3 h-3 text-amber-400" />
              <span className="text-[11px]">
                文件 ({filteredTreeFiles.length})
              </span>
            </button>
          )}

          {effectiveFiles.length > 0 && (
            <button
              type="button"
              onClick={handleRevertAll}
              disabled={isReverting}
              className="flex items-center gap-1 px-2 py-1 rounded bg-[#222226] hover:bg-[#2B2B30] text-[#ECECED] hover:text-white border border-white/10 text-xs transition-colors shrink-0 cursor-pointer"
              title="撤销当前全部文件的变更"
            >
              {isReverting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Undo2 className="w-3 h-3" />
              )}
              <span className="text-[11px] hidden sm:inline">撤销全部</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleCopyCurrentDiff}
            className="p-1.5 rounded hover:text-white hover:bg-white/10 transition-colors"
            title="复制修改后的代码"
          >
            {isCopied ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* 当前选中文件信息条 */}
      {activeFile && (
        <div className="h-9 px-3 bg-[#1C1C1F] border-b border-[#242427] flex items-center justify-between shrink-0 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono truncate text-white">
              {activeFile.name}
            </span>
            <span className="text-[11px] font-mono text-zinc-500 truncate max-w-[200px] hidden md:inline">
              {activeFile.path}
            </span>
            <span className="text-[11px] font-mono text-emerald-400 shrink-0">
              +{activeFile.additions}
            </span>
            <span className="text-[11px] font-mono text-rose-400 shrink-0">
              -{activeFile.deletions}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {/* 撤销当前文件 */}
            <button
              type="button"
              onClick={() => handleRevertFile(activeFile)}
              disabled={isReverting}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-xs text-[#8E8E93] hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              title="撤销本文件修改并恢复原始代码"
            >
              {isReverting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Undo2 className="w-3 h-3" />
              )}
              <span>撤销修改</span>
            </button>

            {/* 在编辑器中独立打开 */}
            <button
              type="button"
              onClick={() => {
                openFileInExplorer({
                  filePath: activeFile.path,
                  title: activeFile.name,
                  content: activeFile.modifiedContent,
                  createAsNewTab: true,
                });
              }}
              className="p-1 rounded hover:text-white text-[#8E8E93] hover:bg-white/10 transition-colors"
              title="在编辑器 Tab 中独立打开此文件"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* MonacoDiffEditor 差异比对画布 */}
      <div className="flex-1 min-h-0 w-full relative bg-[#161618]">
        {activeFile ? (
          <MonacoDiffEditor
            key={`${activeFile.path}-${diffLayout}`}
            original={activeFile.originalContent || ""}
            modified={activeFile.modifiedContent || activeFile.unifiedDiff || ""}
            language={getFileLanguage(activeFile.name || activeFile.path)}
            diffLayout={diffLayout}
            readOnly={true}
          />
        ) : (
          <div className="py-8 text-center text-[#71717A] text-xs">
            请从右侧列表选择要查看的文件
          </div>
        )}
      </div>
    </div>
  );

  // 右侧内嵌变更目录树
  const renderFilesList = (isFullWidth: boolean) => (
    <div
      className={`${
        isFullWidth ? "w-full" : "w-[240px]"
      } h-full flex flex-col bg-[#141416] shrink-0`}
    >
      {/* 顶部标题与切换栏 */}
      <div className="px-2.5 py-2 border-b border-[#242427] bg-[#17171A] flex items-center justify-between">
        <span className="text-xs font-mono font-medium text-white truncate">
          变更文件 ({filteredTreeFiles.length})
        </span>

        {isCompact && activeFile && (
          <button
            type="button"
            onClick={() => setCompactView("diff")}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-amber-400 hover:text-white hover:bg-white/10 transition-colors text-xs cursor-pointer"
            title="返回对比查看"
          >
            <GitCompare className="w-3 h-3" />
            <span className="text-[10px]">对比</span>
          </button>
        )}
      </div>

      {/* 筛选框 */}
      <div className="p-2 border-b border-[#242427]">
        <div className="relative flex items-center bg-[#1A1A1D] border border-white/10 rounded-md px-2 py-1">
          <Search className="w-3.5 h-3.5 text-[#71717A] mr-1.5 shrink-0" />
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="🔍 筛选文件..."
            className="bg-transparent text-white outline-none w-full text-xs font-mono placeholder:text-[#66666D]"
          />
          {filterQuery && (
            <button onClick={() => setFilterQuery("")}>
              <X className="w-3 h-3 text-[#71717A]" />
            </button>
          )}
        </div>
      </div>

      {/* 变更文件列表 */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5 text-xs">
        {filteredTreeFiles.map((file) => {
          const isSelected = activePath === file.path;

          return (
            <button
              key={file.path}
              type="button"
              onClick={() => {
                setActivePath(file.path);
                prevPropPathRef.current = file.path;
                if (storeChangesTab) {
                  useWorkbenchStore
                    .getState()
                    .updateTab(storeChangesTab.id, { selectedFilePath: file.path });
                }
                if (isCompact) {
                  setCompactView("diff");
                }
              }}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left transition-colors cursor-pointer group ${
                isSelected
                  ? "bg-white/15 text-white font-medium"
                  : "hover:bg-white/[0.06] text-[#A1A1AA] hover:text-white"
              }`}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="truncate font-mono text-[11px]">
                  {file.name}
                </span>
              </div>

              <div className="flex items-center gap-1 font-mono text-[10px] shrink-0 pl-1">
                <span className="text-emerald-400">+{file.additions}</span>
                {file.deletions > 0 && (
                  <span className="text-rose-400">-{file.deletions}</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="flex w-full h-full bg-[#161618] text-[#ECECED] select-none">
      {isCompact ? (
        compactView === "diff" ? (
          renderDiffStage(true)
        ) : (
          renderFilesList(true)
        )
      ) : (
        <>
          {renderDiffStage(false)}
          {renderFilesList(false)}
        </>
      )}
    </div>
  );
}
