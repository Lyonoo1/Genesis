"use client";

import React, { useEffect } from "react";
import { Folder, SquareTerminal, Globe, MoreHorizontal, Bot } from "lucide-react";
import { useWorkbenchStore } from "@/stores/useWorkbenchStore";
import { useChatStore } from "@/stores/useChatStore";

interface NewTabViewProps {
  tabId: string;
}

export function NewTabView({ tabId }: NewTabViewProps) {
  const switchNewTabToTool = useWorkbenchStore((s) => s.switchNewTabToTool);
  const activeSessionId = useWorkbenchStore((s) => s.activeSessionId);
  const cachedCount = useWorkbenchStore(
    (s) => s.workbenchBySession[s.activeSessionId]?.cachedSubagents?.length || 0
  );

  // 严格返回布尔基元类型，杜绝返回临时数组引用引起的无限循环重渲染
  const hasSubagentCalls = useChatStore((s) => {
    const list = s.messagesBySession[activeSessionId];
    if (!list || !Array.isArray(list)) return false;
    return list.some((m) =>
      m.raw_tool_calls?.some((tc) => tc.name && tc.name.includes("dispatch_subagent"))
    );
  });
  const hasSubagents = cachedCount > 0 || hasSubagentCalls;

  const handleOpenFiles = () => {
    switchNewTabToTool(tabId, "file-explorer");
  };

  const handleOpenTerminal = () => {
    switchNewTabToTool(tabId, "terminal");
  };

  const handleOpenBrowser = () => {
    switchNewTabToTool(tabId, "browser");
  };

  const handleOpenSubagents = () => {
    switchNewTabToTool(tabId, "subagent-panel");
  };

  // 快捷键支持：⌘P (文件) 与 ^` (终端)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        handleOpenFiles();
      } else if (e.ctrlKey && (e.key === "`" || e.code === "Backquote")) {
        e.preventDefault();
        handleOpenTerminal();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [tabId]);

  return (
    <div className="flex-1 w-full h-full flex flex-col items-center justify-center p-6 bg-[#161618] select-none overflow-y-auto">
      <div className="w-full max-w-[380px] -mt-12">
        {/* 小分类标题：工具 */}
        <h3 className="text-sm font-medium text-white mb-3 px-0.5">
          工具
        </h3>

        {/* 工具卡片列表：文件、终端、浏览器、协作代理 */}
        <div className="flex flex-col gap-2">
          {/* 卡片 1: 文件 */}
          <button
            type="button"
            onClick={handleOpenFiles}
            className="w-full h-11 flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-[#1F1F21] hover:bg-[#27272A] border border-white/[0.04] transition-colors text-left group cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <Folder className="w-4 h-4 text-[#D4D4D8] stroke-[1.6]" />
              <span className="text-sm font-normal text-white">文件</span>
            </div>
            <span className="font-mono text-xs text-[#9A9AA0] bg-[#2A2A2E] px-2 py-0.5 rounded-md">
              ⌘P
            </span>
          </button>

          {/* 卡片 2: 终端 */}
          <button
            type="button"
            onClick={handleOpenTerminal}
            className="w-full h-11 flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-[#1F1F21] hover:bg-[#27272A] border border-white/[0.04] transition-colors text-left group cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <SquareTerminal className="w-4 h-4 text-[#D4D4D8] stroke-[1.6]" />
              <span className="text-sm font-normal text-white">终端</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-[#9A9AA0] bg-[#2A2A2E] px-2 py-0.5 rounded-md">
                ^`
              </span>
              <div className="p-0.5 text-[#71717A] group-hover:text-[#A1A1AA] transition-colors">
                <MoreHorizontal className="w-4 h-4" />
              </div>
            </div>
          </button>

          {/* 卡片 3: 浏览器 */}
          <button
            type="button"
            onClick={handleOpenBrowser}
            className="w-full h-11 flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-[#1F1F21] hover:bg-[#27272A] border border-white/[0.04] transition-colors text-left group cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <Globe className="w-4 h-4 text-[#D4D4D8] stroke-[1.6]" />
              <span className="text-sm font-normal text-white">浏览器</span>
            </div>
          </button>

          {/* 卡片 4: 协作代理（仅当当前会话存在子代理历史记录时才展示，无记录时彻底隐藏） */}
          {hasSubagents && (
            <button
              type="button"
              onClick={handleOpenSubagents}
              className="w-full h-11 flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-[#1F1F21] hover:bg-[#27272A] border border-white/[0.04] transition-colors text-left group cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <Bot className="w-4 h-4 text-[#D4D4D8] stroke-[1.6]" />
                <span className="text-sm font-normal text-white">协作代理</span>
              </div>
              <span className="font-mono text-xs text-[#9A9AA0] bg-[#2A2A2E] px-2 py-0.5 rounded-md">
                {cachedCount > 0 ? `${cachedCount} 个代理` : "查看记录"}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
