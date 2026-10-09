"use client";

import React, { useState } from "react";
import {
  Copy,
  Check,
  Folder,
  Clock,
  Cpu,
  FileText,
  Maximize2,
  Minimize2,
  MessageSquarePlus,
  Globe,
  Terminal,
  ChevronLeft,
  HardDrive,
  Cloud,
} from "lucide-react";
import { useUIStore } from "@/stores/useUIStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { LocalWorkspacePanel } from "./LocalWorkspacePanel";

export function RightSidebar() {
  const {
    isRightSidebarOpen,
    activeInspectorTab,
    setActiveInspectorTab,
    selectedFileId,
    setSelectedFileId,
    previewFiles,
  } = useUIStore();

  const {
    sessions,
    activeSessionId,
    projects,
    selectedModel,
    reasoningEffort,
    approvalMode,
  } = useSessionStore();

  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<"menu" | "detail">("menu");
  const [fileSourceMode, setFileSourceMode] = useState<"local" | "cloud">("local");

  const targetWidthClass = isExpanded ? "w-[560px]" : "w-[380px]";

  const currentFile =
    (previewFiles || []).find((f) => f && f.id === selectedFileId) || (previewFiles || [])[0];

  const activeSession = (sessions || []).find((s) => s && s.id === activeSessionId);
  const activeProject = (projects || []).find(
    (p) => p && p.id === activeSession?.project_id
  );

  const handleCopyCode = () => {
    if (!currentFile || !currentFile.content) return;
    navigator.clipboard.writeText(currentFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const lines = currentFile && typeof currentFile.content === "string" ? currentFile.content.split("\n") : [];

  return (
    <aside
      className={`h-full flex-shrink-0 overflow-hidden transition-[width] duration-[600ms] ease-out z-20 ${
        isRightSidebarOpen ? targetWidthClass : "w-0 pointer-events-none"
      }`}
    >
      <div
        className={`h-full ${targetWidthClass} flex flex-col bg-[#161618] border-l border-[#2A2A2E] select-none overflow-hidden text-[#ECECED] transition-transform duration-[600ms] ease-out ${
          isRightSidebarOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
      {/* 1. 顶栏：完全不被分割线分割，右上角无缝对标官方 Codex (图 2) */}
      <div className="h-11 px-3 flex items-center justify-between flex-shrink-0 bg-[#161618]">
        <div className="flex items-center gap-1.5 min-w-0">
          {viewMode === "detail" ? (
            <>
              <button
                type="button"
                onClick={() => setViewMode("menu")}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs text-[#8E8E93] hover:text-white hover:bg-white/[0.06] transition-colors"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>返回</span>
              </button>

              {activeInspectorTab === "preview" && (
                <div className="flex items-center bg-[#1E1E22] p-0.5 rounded-lg border border-white/5 ml-1 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setFileSourceMode("local")}
                    className={`flex items-center gap-1 px-2 py-0.5 rounded-md transition-colors ${
                      fileSourceMode === "local"
                        ? "bg-[#2A2A2E] text-white font-medium shadow-sm"
                        : "text-[#8E8E93] hover:text-white"
                    }`}
                  >
                    <HardDrive className="w-3 h-3 text-emerald-400" />
                    <span>本地磁盘</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setFileSourceMode("cloud")}
                    className={`flex items-center gap-1 px-2 py-0.5 rounded-md transition-colors ${
                      fileSourceMode === "cloud"
                        ? "bg-[#2A2A2E] text-white font-medium shadow-sm"
                        : "text-[#8E8E93] hover:text-white"
                    }`}
                  >
                    <Cloud className="w-3 h-3 text-blue-400" />
                    <span>云端快照</span>
                  </button>
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* 右侧控制组：只保留展宽按钮，关闭由全局 fixed 按钮负责 */}
        <div className="flex items-center gap-1 text-[#8E8E93] mr-7">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 rounded hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
            title={isExpanded ? "还原宽度" : "最大化侧边栏"}
          >
            {isExpanded ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* 2. 主内容区：默认展示对标图 2 的 4 个核心快捷卡片 */}
      {viewMode === "menu" ? (
        <div className="flex-1 p-4 flex flex-col justify-center gap-2.5 max-w-[340px] mx-auto w-full animate-in fade-in duration-150">
          {/* 文件 */}
          <button
            type="button"
            onClick={() => {
              setActiveInspectorTab("preview");
              setViewMode("detail");
            }}
            className="flex items-center justify-between px-3.5 py-3 rounded-xl bg-[#1E1E20] hover:bg-[#232326] border border-white/[0.06] text-[#ECECED] transition-all cursor-pointer group shadow-sm hover:border-white/10"
          >
            <div className="flex items-center gap-3">
              <Folder className="w-4 h-4 text-[#8E8E93] group-hover:text-white transition-colors" />
              <span className="text-xs font-medium">文件</span>
            </div>
            <span className="font-mono text-[11px] text-[#8E8E93] px-1.5 py-0.5 rounded bg-white/[0.06]">
              ⌘P
            </span>
          </button>

          {/* 侧边聊天 */}
          <button
            type="button"
            onClick={() => {
              setActiveInspectorTab("info");
              setViewMode("detail");
            }}
            className="flex items-center justify-between px-3.5 py-3 rounded-xl bg-[#1E1E20] hover:bg-[#232326] border border-white/[0.06] text-[#ECECED] transition-all cursor-pointer group shadow-sm hover:border-white/10"
          >
            <div className="flex items-center gap-3">
              <MessageSquarePlus className="w-4 h-4 text-[#8E8E93] group-hover:text-white transition-colors" />
              <span className="text-xs font-medium">侧边聊天</span>
            </div>
            <span className="font-mono text-[11px] text-[#8E8E93] px-1.5 py-0.5 rounded bg-white/[0.06]">
              ⌥⌘S
            </span>
          </button>

          {/* 浏览器 */}
          <button
            type="button"
            className="flex items-center justify-between px-3.5 py-3 rounded-xl bg-[#1E1E20] hover:bg-[#232326] border border-white/[0.06] text-[#ECECED] transition-all cursor-pointer group shadow-sm hover:border-white/10"
          >
            <div className="flex items-center gap-3">
              <Globe className="w-4 h-4 text-[#8E8E93] group-hover:text-white transition-colors" />
              <span className="text-xs font-medium">浏览器</span>
            </div>
            <span className="font-mono text-[11px] text-[#8E8E93] px-1.5 py-0.5 rounded bg-white/[0.06]">
              ⌘T
            </span>
          </button>

          {/* 终端 */}
          <button
            type="button"
            className="flex items-center justify-between px-3.5 py-3 rounded-xl bg-[#1E1E20] hover:bg-[#232326] border border-white/[0.06] text-[#ECECED] transition-all cursor-pointer group shadow-sm hover:border-white/10"
          >
            <div className="flex items-center gap-3">
              <Terminal className="w-4 h-4 text-[#8E8E93] group-hover:text-white transition-colors" />
              <span className="text-xs font-medium">终端</span>
            </div>
            <span className="font-mono text-[11px] text-[#8E8E93] px-1.5 py-0.5 rounded bg-white/[0.06]">
              ^`
            </span>
          </button>
        </div>
      ) : activeInspectorTab === "preview" ? (
        fileSourceMode === "local" ? (
          <LocalWorkspacePanel
            projectId={activeProject?.id || activeSession?.project_id || null}
            onFallbackToCloud={() => setFileSourceMode("cloud")}
          />
        ) : (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* 文件切换选项卡列表 */}
          <div className="px-2.5 py-2 border-b border-[#2E2E33] flex items-center gap-1.5 overflow-x-auto scrollbar-none bg-[#1A1A1C]">
            {(previewFiles || []).map((file) => {
              const isSelected = file.id === currentFile?.id;
              return (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => setSelectedFileId(file.id)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-xs whitespace-nowrap transition-colors border ${
                    isSelected
                      ? "bg-[#2A2A2E] text-white border-white/20 font-medium"
                      : "bg-transparent text-[#8E8E93] border-transparent hover:text-white hover:bg-white/[0.04]"
                  }`}
                >
                  <FileText className="w-3 h-3 shrink-0" />
                  <span className="truncate max-w-[130px]">{file.name}</span>
                </button>
              );
            })}
          </div>

          {/* 当前文件元信息与复制按钮 */}
          {currentFile && (
            <div className="px-3 py-2 bg-[#212124] border-b border-[#2E2E33] flex items-center justify-between text-[11px] text-[#8E8E93]">
              <div className="flex items-center gap-2 truncate pr-2">
                <span className="font-mono text-white truncate">
                  {currentFile.path}
                </span>
                <span className="px-1.5 py-0.5 rounded bg-white/[0.06] text-[#A1A1AA] uppercase text-[10px]">
                  {currentFile.language}
                </span>
              </div>
              <button
                type="button"
                onClick={handleCopyCode}
                className="flex items-center gap-1 px-2 py-0.5 rounded hover:text-white hover:bg-white/[0.08] transition-colors shrink-0 text-xs"
                title="复制内容"
              >
                {copied ? (
                  <>
                    <Check className="w-3 h-3 text-accent-green" />
                    <span className="text-accent-green">已复制</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>复制</span>
                  </>
                )}
              </button>
            </div>
          )}

          {/* 代码预览区域（行号 + 代码） */}
          <div className="flex-1 overflow-auto font-mono text-[12px] leading-5 p-3 select-text bg-[#18181A]">
            {currentFile ? (
              <table className="w-full border-collapse">
                <tbody>
                  {lines.map((line, idx) => (
                    <tr key={idx} className="hover:bg-white/[0.03]">
                      <td className="w-8 pr-3 text-right text-[#55555C] select-none align-top font-mono text-[11px]">
                        {idx + 1}
                      </td>
                      <td className="text-[#D4D4D8] whitespace-pre font-mono">
                        {line || " "}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-[#71717A]">
                暂无选中文件
              </div>
            )}
          </div>

          {/* 底部状态栏 */}
          {currentFile && (
            <div className="h-7 px-3 border-t border-[#2E2E33] bg-[#1E1E20] flex items-center justify-between text-[11px] text-[#71717A]">
              <span>{lines.length} 行</span>
              <span>{currentFile.size}</span>
              <span>UTF-8</span>
            </div>
          )}
        </div>
        )
      ) : (
        /* 3. 会话信息 Tab */
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
          {/* 基本信息卡片 */}
          <div className="p-3.5 rounded-xl bg-[#232326] border border-[#323232] space-y-3">
            <div className="flex items-center gap-2 text-white font-medium text-[13px] border-b border-[#2E2E33] pb-2">
              <Folder className="w-4 h-4 text-codex-muted" />
              <span className="truncate">{activeSession?.title || "未选择会话"}</span>
            </div>

            <div className="space-y-2 text-[#A1A1AA]">
              <div className="flex items-center justify-between">
                <span>所属项目</span>
                <span className="text-white font-medium">
                  {activeProject?.name || "默认工作区"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>会话 ID</span>
                <span className="font-mono text-[11px] text-[#D4D4D8] truncate max-w-[170px]">
                  {activeSession?.id || "--"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>置顶状态</span>
                <span className="text-white">
                  {activeSession?.pinned ? "已置顶" : "普通"}
                </span>
              </div>
            </div>
          </div>

          {/* 模型与执行配置卡片 */}
          <div className="p-3.5 rounded-xl bg-[#232326] border border-[#323232] space-y-3">
            <div className="flex items-center gap-2 text-white font-medium text-[13px] border-b border-[#2E2E33] pb-2">
              <Cpu className="w-4 h-4 text-codex-muted" />
              <span>模型与推理配置</span>
            </div>

            <div className="space-y-2 text-[#A1A1AA]">
              <div className="flex items-center justify-between">
                <span>当前模型</span>
                <span className="text-white font-mono font-medium">
                  {selectedModel || "GPT-5.5"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>思考深度</span>
                <span className="capitalize text-white">
                  {reasoningEffort || "high"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>执行授权模式</span>
                <span className="capitalize text-white">
                  {approvalMode || "approval"}
                </span>
              </div>
            </div>
          </div>

          {/* 时间与时区卡片 */}
          <div className="p-3.5 rounded-xl bg-[#232326] border border-[#323232] space-y-3">
            <div className="flex items-center gap-2 text-white font-medium text-[13px] border-b border-[#2E2E33] pb-2">
              <Clock className="w-4 h-4 text-codex-muted" />
              <span>时间戳 (北京时间 UTC+8)</span>
            </div>

            <div className="space-y-2 text-[#A1A1AA]">
              <div className="flex items-center justify-between">
                <span>创建时间</span>
                <span className="text-white font-mono text-[11px]">
                  {activeSession?.created_at
                    ? new Date(activeSession.created_at).toLocaleString("zh-CN", {
                        timeZone: "Asia/Shanghai",
                      })
                    : "--"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>最后更新</span>
                <span className="text-white font-mono text-[11px]">
                  {activeSession?.updated_at
                    ? new Date(activeSession.updated_at).toLocaleString("zh-CN", {
                        timeZone: "Asia/Shanghai",
                      })
                    : "--"}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
      </div>
    </aside>
  );
}
