"use client";

import React, { useState } from "react";
import {
  Folder,
  FolderOpen,
  FileCode,
  FileText,
  HardDrive,
  RefreshCw,
  Unlink,
  ShieldCheck,
  ChevronRight,
  ChevronDown,
  Copy,
  Check,
  Laptop,
  AlertTriangle,
} from "lucide-react";
import { useLocalWorkspace } from "@/hooks/useLocalWorkspace";
import { WorkspaceFileNode } from "@/lib/workspace/localWorkspaceManager";

interface LocalWorkspacePanelProps {
  projectId: string | null;
  onFallbackToCloud?: () => void;
}

export function LocalWorkspacePanel({
  projectId,
  onFallbackToCloud,
}: LocalWorkspacePanelProps) {
  const {
    status,
    directoryName,
    fileTree,
    isScanning,
    activeFilePath,
    activeFileContent,
    activeFileSize,
    isLoadingFile,
    attachDirectory,
    requestAccess,
    disconnect,
    selectFile,
    refreshTree,
  } = useLocalWorkspace(projectId);

  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!activeFileContent) return;
    navigator.clipboard.writeText(activeFileContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  // 1. 状态：换了电脑访问（当前设备未找到句柄）
  if (status === "DISCONNECTED_DEVICE") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center select-none bg-[#161618]">
        <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mb-4 shadow-inner">
          <Laptop className="w-6 h-6" />
        </div>
        <h3 className="text-sm font-semibold text-white mb-1.5">
          当前设备未关联本地工作区
        </h3>
        <p className="text-xs text-[#8E8E93] leading-relaxed max-w-[280px] mb-5">
          因浏览器安全沙盒限制，文件授权仅保存在原电脑。若当前电脑也有该项目，可直接关联；或浏览云端生成的文件。
        </p>

        <div className="w-full max-w-[280px] space-y-2.5">
          <button
            type="button"
            onClick={attachDirectory}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 bg-white text-black text-xs font-semibold rounded-lg hover:bg-[#E5E5EA] transition-all cursor-pointer shadow"
          >
            <HardDrive className="w-3.5 h-3.5" />
            <span>关联当前电脑的项目文件夹</span>
          </button>

          {onFallbackToCloud && (
            <button
              type="button"
              onClick={onFallbackToCloud}
              className="w-full py-2 px-3 bg-white/[0.04] text-[#A1A1AA] hover:text-white hover:bg-white/[0.08] text-xs font-medium rounded-lg transition-all cursor-pointer border border-white/5"
            >
              仅查看云端生成文件快照
            </button>
          )}
        </div>
      </div>
    );
  }

  // 2. 状态：同台电脑刷新后需要重新激活授权
  if (status === "NEED_PERMISSION") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center select-none bg-[#161618]">
        <div className="w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center mb-4">
          <ShieldCheck className="w-6 h-6" />
        </div>
        <h3 className="text-sm font-semibold text-white mb-1.5">
          需要唤醒本地文件访问权限
        </h3>
        <p className="text-xs text-[#8E8E93] leading-relaxed max-w-[280px] mb-5">
          已检测到已绑定的本地目录{" "}
          <span className="font-mono text-white bg-white/[0.08] px-1.5 py-0.5 rounded">
            {directoryName || "工作区"}
          </span>
          ，点击下方按钮恢复实时读写。
        </p>

        <button
          type="button"
          onClick={requestAccess}
          className="py-2 px-4 bg-white text-black text-xs font-semibold rounded-lg hover:bg-[#E5E5EA] transition-all cursor-pointer shadow"
        >
          点击恢复本地访问权限
        </button>
      </div>
    );
  }

  // 3. 状态：不支持 File System Access API
  if (status === "UNSUPPORTED") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center select-none bg-[#161618]">
        <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 flex items-center justify-center mb-4">
          <AlertTriangle className="w-6 h-6" />
        </div>
        <h3 className="text-sm font-semibold text-white mb-1.5">
          当前浏览器不支持访问本地磁盘
        </h3>
        <p className="text-xs text-[#8E8E93] leading-relaxed max-w-[280px] mb-4">
          建议使用 Chrome、Edge 或 Arc 浏览器使用该功能。
        </p>
        {onFallbackToCloud && (
          <button
            type="button"
            onClick={onFallbackToCloud}
            className="py-2 px-4 bg-white/[0.06] text-white text-xs font-medium rounded-lg hover:bg-white/10 transition-all cursor-pointer"
          >
            切换为云端文件预览
          </button>
        )}
      </div>
    );
  }

  // 4. 状态：正常连接 CONNECTED (展示真实本地目录树 + 代码查看器)
  const lines = activeFileContent ? activeFileContent.split("\n") : [];

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[#161618]">
      {/* 顶部工作区工具栏 */}
      <div className="h-10 px-3 bg-[#1A1A1D] border-b border-[#2A2A2E] flex items-center justify-between flex-shrink-0 text-xs">
        <div className="flex items-center gap-2 min-w-0 pr-2">
          <HardDrive className="w-3.5 h-3.5 text-accent-green shrink-0" />
          <span className="font-medium text-white truncate" title={directoryName}>
            {directoryName}
          </span>
          <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 shrink-0">
            本地已连接
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={refreshTree}
            disabled={isScanning}
            className="p-1 rounded text-[#8E8E93] hover:text-white hover:bg-white/[0.08] transition-colors"
            title="刷新本地文件树"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isScanning ? "animate-spin text-white" : ""}`}
            />
          </button>
          <button
            type="button"
            onClick={disconnect}
            className="p-1 rounded text-[#8E8E93] hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
            title="断开当前本地工作区"
          >
            <Unlink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 主体分栏：上部文件树 (折叠区) + 下部代码预览区 */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* 1. 文件树折叠面板 */}
        <div className="h-44 border-b border-[#2A2A2E] overflow-y-auto p-2 bg-[#171719] select-none text-[12px]">
          {fileTree.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-[#71717A]">
              {isScanning ? "正在扫描本地文件..." : "目录为空"}
            </div>
          ) : (
            <div className="space-y-0.5">
              {fileTree.map((node) => (
                <FileTreeNode
                  key={node.path}
                  node={node}
                  activePath={activeFilePath}
                  onSelect={(path) => selectFile(path)}
                  level={0}
                />
              ))}
            </div>
          )}
        </div>

        {/* 2. 当前选中文件的代码详情 */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[#18181A]">
          {/* 代码头：文件名 + 大小 + 复制 */}
          <div className="px-3 py-1.5 bg-[#1F1F22] border-b border-[#2A2A2E] flex items-center justify-between text-[11px] text-[#8E8E93]">
            <div className="flex items-center gap-2 truncate pr-2">
              <span className="font-mono text-white truncate">
                {activeFilePath || "未选择文件"}
              </span>
              {activeFileSize && (
                <span className="text-[10px] text-[#71717A] shrink-0 font-mono">
                  {activeFileSize}
                </span>
              )}
            </div>

            {activeFileContent && (
              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center gap-1 px-2 py-0.5 rounded hover:text-white hover:bg-white/[0.08] transition-colors shrink-0 text-xs"
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
            )}
          </div>

          {/* 代码视图 */}
          <div className="flex-1 overflow-auto font-mono text-[12px] leading-5 p-3 select-text bg-[#141416]">
            {isLoadingFile ? (
              <div className="h-full flex items-center justify-center text-xs text-[#71717A]">
                正在从磁盘读取文件...
              </div>
            ) : activeFileContent ? (
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
                点击上方文件树中的文件以实时查看内容
              </div>
            )}
          </div>

          {/* 状态栏 */}
          <div className="h-6 px-3 border-t border-[#2A2A2E] bg-[#1A1A1D] flex items-center justify-between text-[10px] text-[#71717A] select-none">
            <span>{lines.length} 行代码</span>
            <span className="text-emerald-400/80">真实本地磁盘直连</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// 递归节点组件
function FileTreeNode({
  node,
  activePath,
  onSelect,
  level,
}: {
  node: WorkspaceFileNode;
  activePath: string;
  onSelect: (path: string) => void;
  level: number;
}) {
  const [isOpen, setIsOpen] = useState(level === 0);
  const isDirectory = node.kind === "directory";
  const isSelected = activePath === node.path;

  const handleClick = () => {
    if (isDirectory) {
      setIsOpen(!isOpen);
    } else {
      onSelect(node.path);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        style={{ paddingLeft: `${level * 12 + 6}px` }}
        className={`w-full flex items-center gap-1.5 py-1 pr-2 rounded text-left transition-colors cursor-pointer group ${
          isSelected
            ? "bg-white/[0.12] text-white font-medium"
            : "text-[#A1A1AA] hover:text-white hover:bg-white/[0.04]"
        }`}
      >
        {isDirectory ? (
          <>
            {isOpen ? (
              <ChevronDown className="w-3 h-3 text-[#71717A] shrink-0" />
            ) : (
              <ChevronRight className="w-3 h-3 text-[#71717A] shrink-0" />
            )}
            {isOpen ? (
              <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            ) : (
              <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            )}
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            {node.name.endsWith(".ts") ||
            node.name.endsWith(".tsx") ||
            node.name.endsWith(".js") ||
            node.name.endsWith(".py") ? (
              <FileCode className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            ) : (
              <FileText className="w-3.5 h-3.5 text-[#8E8E93] shrink-0" />
            )}
          </>
        )}
        <span className="truncate text-xs">{node.name}</span>
      </button>

      {isDirectory && isOpen && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              activePath={activePath}
              onSelect={onSelect}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
