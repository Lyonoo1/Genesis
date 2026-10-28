"use client";

import React, { useState, useMemo, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import {
  FileCode,
  Search,
  X,
  HardDrive,
  ChevronRight,
  ChevronDown,
  Folders,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/chat/MarkdownRenderer";
import { useCanvasStore } from "@/stores/useCanvasStore";
import { useLocalWorkspace } from "@/hooks/useLocalWorkspace";
import { useSessionStore } from "@/stores/useSessionStore";
import { WorkspaceFileNode } from "@/lib/workspace/localWorkspaceManager";
import { BreadcrumbsDropdown } from "../BreadcrumbsDropdown";
import { EditorLoadingSkeleton } from "@/components/canvas/EditorLoadingSkeleton";

const MonacoCodeEditor = dynamic(
  () =>
    import("@/components/canvas/MonacoCodeEditor").then((mod) => ({
      default: mod.MonacoCodeEditor,
    })),
  { ssr: false, loading: () => <EditorLoadingSkeleton /> }
);

interface FileExplorerTabViewProps {
  selectedFilePath: string | null;
  onSelectFile: (filePath: string, content?: string, name?: string) => void;
}


// 文件类型徽章小图标
function getFileLanguageBadge(name: string) {
  const n = (name || "").toLowerCase();
  if (n.endsWith(".vue")) {
    return <span className="text-emerald-400 font-bold text-[9px] shrink-0">V</span>;
  }
  if (n.endsWith(".js") || n.endsWith(".jsx")) {
    return (
      <span className="bg-amber-400 text-black px-0.5 rounded-[2px] font-bold text-[7px] shrink-0">
        JS
      </span>
    );
  }
  if (n.endsWith(".ts") || n.endsWith(".tsx")) {
    return (
      <span className="bg-blue-500 text-white px-0.5 rounded-[2px] font-bold text-[7px] shrink-0">
        TS
      </span>
    );
  }
  if (n.endsWith(".py")) {
    return <span className="text-blue-400 font-bold text-[8px] shrink-0">PY</span>;
  }
  if (n.endsWith(".md")) {
    return <span className="text-sky-400 font-bold text-[8px] shrink-0">M↓</span>;
  }
  if (n.endsWith(".toml") || n.endsWith(".yaml") || n.endsWith(".yml") || n.endsWith(".json")) {
    return <span className="text-amber-400 font-bold text-[8px] shrink-0">{}</span>;
  }
  if (n.startsWith(".env")) {
    return <span className="text-emerald-400 font-bold text-[8px] shrink-0">ENV</span>;
  }
  return <FileCode className="w-3.5 h-3.5 text-zinc-400 shrink-0" />;
}

// 单个目录树节点递归渲染 (图 2 同款层级与高亮)
function FileTreeNodeItem({
  node,
  activePath,
  onSelectFile,
  level = 0,
}: {
  node: WorkspaceFileNode;
  activePath: string;
  onSelectFile: (path: string) => void;
  level?: number;
}) {
  const [isOpen, setIsOpen] = useState(level < 2 || activePath.startsWith(node.path));
  const isSelected = activePath === node.path;
  const isDir = node.kind === "directory";

  useEffect(() => {
    if (activePath && (activePath.startsWith(node.path + "/") || activePath === node.path)) {
      setIsOpen(true);
    }
  }, [activePath, node.path]);

  return (
    <div>
      <div
        onClick={() => {
          if (isDir) {
            setIsOpen(!isOpen);
          } else {
            onSelectFile(node.path);
          }
        }}
        style={{ paddingLeft: `${Math.max(4, level * 14)}px` }}
        className={`flex items-center gap-1.5 py-1 px-2 rounded-md text-xs cursor-pointer select-none transition-colors ${
          isSelected
            ? "bg-[#2A2A30] text-white font-medium shadow-sm"
            : "hover:bg-white/[0.06] text-[#A1A1AA] hover:text-white"
        }`}
      >
        {isDir ? (
          <>
            {isOpen ? (
              <ChevronDown className="w-3.5 h-3.5 text-[#71717A] shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-[#71717A] shrink-0" />
            )}
            <span className="truncate font-mono text-[11px]">{node.name}</span>
          </>
        ) : (
          <>
            <span className="w-3.5 flex justify-center shrink-0">
              {getFileLanguageBadge(node.name)}
            </span>
            <span className="truncate font-mono text-[11px]">{node.name}</span>
          </>
        )}
      </div>

      {isDir && isOpen && node.children && (
        <div className="space-y-0.5">
          {node.children.map((child) => (
            <FileTreeNodeItem
              key={child.path}
              node={child}
              activePath={activePath}
              onSelectFile={onSelectFile}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileExplorerTabView({
  selectedFilePath,
  onSelectFile,
}: FileExplorerTabViewProps) {
  const { activeProjectId, activeSessionId, sessions } = useSessionStore();
  const activeSession = (sessions || []).find((s) => s && s.id === activeSessionId);
  const resolvedProjectId = activeProjectId || activeSession?.project_id || null;

  const {
    status: localStatus,
    fileTree,
    isScanning,
    attachDirectory,
  } = useLocalWorkspace(resolvedProjectId);

  const {
    artifacts,
    activeArtifactId,
    updateCurrentContent,
    saveToLocalDisk,
  } = useCanvasStore();

  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const [filterQuery, setFilterQuery] = useState("");
  const [isTreeVisible, setIsTreeVisible] = useState(true);
  const [treeWidth, setTreeWidth] = useState(250);
  const [isResizingTree, setIsResizingTree] = useState(false);

  const activeArtifact = activeArtifactId ? artifacts[activeArtifactId] : null;

  // 检测当前是否为 Markdown 文档
  const currentFilePath = selectedFilePath || activeArtifact?.filePath || activeArtifact?.title || "";
  const isMarkdown = useMemo(() => {
    const p = currentFilePath.toLowerCase();
    return p.endsWith(".md") || p.endsWith(".markdown") || p.endsWith(".mdx");
  }, [currentFilePath]);


  // 保存到本地磁盘
  const handleSaveToDisk = useCallback(async () => {
    if (!activeArtifact) return;
    await saveToLocalDisk(resolvedProjectId);
  }, [activeArtifact, saveToLocalDisk, resolvedProjectId]);

  // 读取并打开选中的本地文件
  const handleSelectFileItem = useCallback(
    async (filePath: string) => {
      let content = "";
      let name = filePath.split("/").pop() || "";

      // 1. 优先从已有 artifacts 提取内容作为保底
      const existingArt = Object.values(artifacts).find(
        (a) => a.filePath === filePath || a.title === name || a.id === filePath
      );
      if (existingArt && existingArt.currentContent) {
        content = existingArt.currentContent;
      }

      // 2. 本地文件系统已连接时，尝试读取磁盘最新真实文件
      if (localStatus === "CONNECTED") {
        try {
          const { getDirectoryHandle, readLocalFile } = await import("@/lib/workspace/localWorkspaceManager");
          const targetKey = resolvedProjectId || "genesis-default-workspace";
          let handle = await getDirectoryHandle(targetKey);
          if (!handle && targetKey !== "genesis-default-workspace") {
            handle = await getDirectoryHandle("genesis-default-workspace");
          }
          if (handle) {
            const res = await readLocalFile(handle, filePath);
            if (res.content !== undefined) {
              content = res.content;
            }
            if (res.name) {
              name = res.name;
            }
          }
        } catch (e) {
          console.warn("读取本地文件失败，使用已有缓存:", e);
        }
      }
      onSelectFile(filePath, content, name);
    },
    [artifacts, localStatus, resolvedProjectId, onSelectFile]
  );

  // 左右拖拽调整文件树宽度
  const handleTreeResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingTree(true);
    const startX = e.clientX;
    const startWidth = treeWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      // 目录树在右侧，向左拖拽变大，向右拖拽变小
      const delta = startX - moveEvent.clientX;
      const newWidth = Math.max(180, Math.min(420, startWidth + delta));
      setTreeWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizingTree(false);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const effectiveFileTree = useMemo(() => {
    if (localStatus === "CONNECTED" && fileTree.length > 0) {
      return fileTree;
    }
    // 未挂载本地文件夹时，自动由 artifacts 合成树状层级，保障面包屑与树永远可用
    const arts = Object.values(artifacts);
    if (arts.length === 0) return [];

    const rootNodes: WorkspaceFileNode[] = [];
    for (const art of arts) {
      const fullPath = art.filePath || art.title || "untitled";
      const parts = fullPath.split("/").filter(Boolean);
      let currentChildren = rootNodes;
      let curPathAcc = "";

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        curPathAcc = curPathAcc ? `${curPathAcc}/${part}` : part;
        const isLeaf = i === parts.length - 1;

        if (isLeaf) {
          currentChildren.push({
            name: part,
            path: curPathAcc,
            kind: "file",
          });
        } else {
          let dirNode = currentChildren.find(
            (n) => n.kind === "directory" && n.name === part
          );
          if (!dirNode) {
            dirNode = {
              name: part,
              path: curPathAcc,
              kind: "directory",
              children: [],
            };
            currentChildren.push(dirNode);
          }
          currentChildren = dirNode.children!;
        }
      }
    }
    return rootNodes;
  }, [localStatus, fileTree, artifacts]);

  // 过滤树节点
  const filteredTree = useMemo(() => {
    if (!filterQuery.trim()) return effectiveFileTree;
    const q = filterQuery.toLowerCase();
    const result: WorkspaceFileNode[] = [];
    const search = (nodes: WorkspaceFileNode[]) => {
      for (const node of nodes) {
        if (node.name.toLowerCase().includes(q)) {
          result.push(node);
        }
        if (node.children) {
          search(node.children);
        }
      }
    };
    search(effectiveFileTree);
    return result;
  }, [effectiveFileTree, filterQuery]);

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-[#161618]">
      {/* 1. 顶部 Toolbar (对标图 2：左侧面包屑药丸，右侧操作组) */}
      <div className="h-11 px-3 bg-[#161618] border-b border-white/[0.06] flex items-center justify-between shrink-0 gap-3">
        {/* 左侧：面包屑级联展开 (图 2 & 图 3) */}
        <div className="flex-1 min-w-0 flex items-center overflow-hidden">
          <BreadcrumbsDropdown
            filePath={selectedFilePath || activeArtifact?.filePath || ""}
            fileTree={effectiveFileTree}
            onSelectFile={handleSelectFileItem}
          />
        </div>

        {/* 右侧动作按钮组 (对标图 1 & 图 2：查看源代码/查看预览 + 显示/隐藏文件目录) */}
        <div className="flex items-center gap-2 shrink-0">
          {/* 功能一：查看源代码 / 查看预览 (仅对 Markdown 类文件呈现) */}
          {isMarkdown && (
            <button
              type="button"
              onClick={() => setViewMode(viewMode === "preview" ? "code" : "preview")}
              className="px-3.5 py-1 rounded-full bg-[#2C2C2E] hover:bg-[#38383B] text-white text-xs font-normal transition-all cursor-pointer select-none shadow-sm"
              title={viewMode === "preview" ? "查看 Markdown 源代码" : "查看渲染后的富文本预览"}
            >
              {viewMode === "preview" ? "查看源代码" : "查看预览"}
            </button>
          )}

          {/* 功能二：显示和隐藏文件目录 (双重文件夹图标 Folders) */}
          <button
            type="button"
            onClick={() => setIsTreeVisible(!isTreeVisible)}
            className={`p-1.5 rounded-lg transition-colors cursor-pointer select-none flex items-center justify-center ${
              isTreeVisible
                ? "text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
                : "text-[#8E8E93] hover:text-white hover:bg-white/[0.08]"
            }`}
            title={isTreeVisible ? "隐藏文件目录" : "显示文件目录"}
          >
            <Folders className="w-4 h-4 stroke-[1.8]" />
          </button>
        </div>
      </div>

      {/* 2. 主体分栏：左侧代码编辑器/预览 + 中间拖拽把手 + 右侧目录树 (图 2 颠覆式升级) */}
      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        {/* 2.1 左侧代码预览区 (Monaco Code Editor 或 Markdown 富文本预览) */}
        <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-[#161618]">
          {activeArtifact?.currentContent !== undefined ? (
            isMarkdown && viewMode === "preview" ? (
              <div className="flex-1 h-full overflow-y-auto px-8 py-6 bg-[#161618] scrollbar-thin select-text">
                <div className="max-w-3xl mx-auto">
                  <MarkdownRenderer content={activeArtifact.currentContent} />
                </div>
              </div>
            ) : (
              <MonacoCodeEditor
                key={activeArtifact.id || selectedFilePath || "code"}
                value={activeArtifact.currentContent}
                language={activeArtifact.language || "typescript"}
                onChange={(val) => updateCurrentContent(val)}
                onSave={handleSaveToDisk}
                readOnly={false}
              />
            )
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center select-none bg-[#161618]">
              <div className="w-12 h-12 rounded-2xl bg-white/[0.04] border border-white/5 flex items-center justify-center text-[#71717A] mb-3 shadow-inner">
                <FileCode className="w-6 h-6 stroke-[1.8]" />
              </div>
              <h3 className="text-sm font-semibold text-white mb-1">
                {localStatus === "CONNECTED" ? "未选择文件" : "未连接本地工作区"}
              </h3>
              <p className="text-xs text-[#71717A] max-w-xs mb-4">
                {localStatus === "CONNECTED"
                  ? "在右侧目录树或上方搜索框中选择文件直接预览与编辑"
                  : "关联本地文件夹以同步浏览并实时编辑本地项目代码"}
              </p>
              {localStatus !== "CONNECTED" && (
                <button
                  type="button"
                  onClick={attachDirectory}
                  className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-xs text-white rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer shadow-sm font-medium"
                >
                  <HardDrive className="w-3.5 h-3.5" />
                  <span>关联本地文件夹</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* 2.2 左右拖拽把手 (仅在目录树显示时启用) */}
        {isTreeVisible && (
          <div
            onMouseDown={handleTreeResizeStart}
            className={`w-1 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500 transition-colors z-30 shrink-0 relative ${
              isResizingTree ? "bg-blue-500 select-none" : "bg-[#26262A]"
            }`}
            title="按住左右拖拽调整目录树宽度"
          >
            <div className="absolute inset-y-0 -left-1 -right-1" />
          </div>
        )}

        {/* 2.3 右侧代码目录树面板 (对标图 2 右侧：筛选框 + 目录树) */}
        {isTreeVisible && (
          <div
            style={{ width: `${treeWidth}px` }}
            className="flex flex-col min-h-0 h-full bg-[#18181A] shrink-0 select-none overflow-hidden"
          >
            {/* 顶部搜索筛选框 (图 2 样式) */}
            <div className="p-2 border-b border-[#242427]">
              <div className="relative flex items-center bg-[#141416] border border-white/10 rounded-lg px-2.5 py-1 focus-within:border-white/20 transition-colors">
                <Search className="w-3.5 h-3.5 text-[#71717A] mr-1.5 shrink-0" />
                <input
                  type="text"
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  placeholder="🔍 筛选文件..."
                  className="bg-transparent text-white outline-none w-full text-xs font-mono placeholder:text-[#55555C]"
                />
                {filterQuery && (
                  <button onClick={() => setFilterQuery("")} className="cursor-pointer">
                    <X className="w-3 h-3 text-[#71717A] hover:text-white" />
                  </button>
                )}
              </div>
            </div>

            {/* 文件树列表 (图 2 样式) */}
            <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5 scrollbar-thin">
              {localStatus !== "CONNECTED" ? (
                <div className="h-full flex flex-col items-center justify-center p-4 text-center select-none">
                  <div className="text-xs text-[#71717A] mb-3">目录树未连接</div>
                  <button
                    type="button"
                    onClick={attachDirectory}
                    className="px-3 py-1 bg-white/[0.08] hover:bg-white/15 text-xs text-white rounded-md transition-colors cursor-pointer"
                  >
                    关联文件夹
                  </button>
                </div>
              ) : effectiveFileTree.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-[#71717A]">
                  {isScanning ? "正在扫描工作区..." : "目录为空"}
                </div>
              ) : filterQuery ? (
                filteredTree.map((item) => (
                  <div
                    key={item.path}
                    onClick={() => handleSelectFileItem(item.path)}
                    className="flex items-center gap-1.5 py-1 px-2 rounded-md hover:bg-white/[0.08] cursor-pointer text-xs font-mono"
                  >
                    {getFileLanguageBadge(item.name)}
                    <span className="truncate text-[#D4D4D8]">{item.name}</span>
                  </div>
                ))
              ) : (
                effectiveFileTree.map((node) => (
                  <FileTreeNodeItem
                    key={node.path}
                    node={node}
                    activePath={selectedFilePath || ""}
                    onSelectFile={handleSelectFileItem}
                    level={0}
                  />
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
