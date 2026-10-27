"use client";

import React, { useState } from "react";
import { Check, Copy, AppWindow } from "lucide-react";
import { useCanvasStore } from "@/stores/useCanvasStore";
import { useUIStore } from "@/stores/useUIStore";

interface CodeBlockProps {
  language?: string;
  code: string;
  filename?: string;
  filePath?: string;
}

export function CodeBlock({
  language = "plaintext",
  code,
  filename,
  filePath,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const cleanLang = language.replace(/^language-/, "");

  const { openArtifact, activeArtifactId, artifacts } = useCanvasStore();
  const { isRightSidebarOpen, openRightSidebar } = useUIStore();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback
    }
  };

  // 在一体化工作台标签页中打开
  const handleOpenInWorkbench = () => {
    const title = filename || filePath?.split("/").pop() || "代码片段";
    const path = filePath || filename || title;

    openArtifact({
      title,
      filePath: path,
      language: cleanLang,
      content: code,
      description: filename
        ? `从对话中导入 ${filename}`
        : `从对话导入代码片段 (${cleanLang})`,
    });

    try {
      const { useWorkbenchStore } = require("@/stores/useWorkbenchStore");
      useWorkbenchStore.getState().openFileInExplorer({
        filePath: path,
        title,
        content: code,
        language: cleanLang,
      });
    } catch {}

    openRightSidebar();
  };

  // 检测该代码块是否已在工作台标签页处于活动状态
  const activeArt = activeArtifactId ? artifacts[activeArtifactId] : null;
  const isCurrentlyInWorkbench =
    isRightSidebarOpen &&
    Boolean(
      activeArt &&
        ((filePath && activeArt.filePath === filePath) ||
          (filename &&
            (activeArt.title === filename || activeArt.filePath === filename)) ||
          activeArt.currentContent === code)
    );

  // 显示的头部标题：优先展示提取出的文件名，否则展示规范化语言
  const displayTitle = filename || cleanLang;

  return (
    <div className="my-3.5 rounded-2xl border border-[#383838]/60 bg-[#212123] overflow-hidden group shadow-sm select-text">
      {/* 顶部状态栏：类似 Codex / Canvas 顶部工具栏 */}
      <div className="h-9 px-3.5 flex items-center justify-between select-none bg-[#1C1C1F] border-b border-[#2C2C30]">
        <div className="flex items-center gap-2 text-xs font-mono min-w-0 pr-2">
          <span className="text-[#8E8E93] font-semibold text-[11px]">&lt;/&gt;</span>
          <span className="font-medium text-[#ECECED] truncate max-w-[260px]">
            {displayTitle}
          </span>
          {filename && (
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-white/[0.06] text-[#A1A1AA] uppercase">
              {cleanLang}
            </span>
          )}
          {isCurrentlyInWorkbench && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.2 rounded bg-blue-500/15 border border-blue-500/20 text-blue-400 font-sans">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              <span>工作台活跃中</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* 在一体化工作台标签页中交互编辑 / 对比按钮 */}
          <button
            type="button"
            onClick={handleOpenInWorkbench}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${
              isCurrentlyInWorkbench
                ? "bg-blue-500/20 text-blue-300 border border-blue-500/30"
                : "text-[#8E8E93] hover:text-white hover:bg-white/[0.08]"
            }`}
            title="在一体化工作台标签页中打开 (支持在线编辑、Markdown三态排版、智能Diff、VS Code唤醒与写回本地磁盘)"
          >
            <AppWindow className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span className="text-[11px] hidden sm:inline">
              {isCurrentlyInWorkbench ? "工作台活跃中" : "在工作台中打开"}
            </span>
          </button>

          {/* 复制代码按钮 */}
          <button
            type="button"
            onClick={handleCopy}
            className="p-1.5 rounded-md text-[#8E8E93] hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
            title="复制代码"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* 代码内容 */}
      <div className="px-4 py-3 overflow-x-auto font-mono text-[13px] leading-relaxed text-[#ECECED] scrollbar-thin bg-[#161618]">
        <pre className="m-0 whitespace-pre">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}
