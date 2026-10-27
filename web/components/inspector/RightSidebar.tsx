"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  X,
  Plus,
  Maximize2,
  Minimize2,
  PanelRightClose,
  Terminal as TerminalIcon,
  FileCode,
  Globe,
  GitCompare,
  Bot,
} from "lucide-react";
import { useUIStore } from "@/stores/useUIStore";
import { useWorkbenchStore, WorkbenchTab } from "@/stores/useWorkbenchStore";
import { useCanvasStore } from "@/stores/useCanvasStore";
import { FileExplorerTabView } from "@/components/workbench/tabs/FileExplorerTabView";
import { TerminalTabView } from "@/components/workbench/tabs/TerminalTabView";
import { BrowserTabView } from "@/components/workbench/tabs/BrowserTabView";
import { ChangesTabView } from "@/components/workbench/tabs/ChangesTabView";
import { NewTabView } from "@/components/workbench/tabs/NewTabView";
import { SubagentTabView } from "@/components/workbench/tabs/SubagentTabView";

// Tab 图标智能解析
function getTabIcon(tab: WorkbenchTab) {
  if (tab.kind === "new-tab") {
    return <Globe className="w-3.5 h-3.5 text-[#8E8E93] shrink-0" />;
  }
  if (tab.kind === "terminal") {
    return <TerminalIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
  }
  if (tab.kind === "browser") {
    return <Globe className="w-3.5 h-3.5 text-sky-400 shrink-0" />;
  }
  if (tab.kind === "changes") {
    return <GitCompare className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
  }
  if (tab.kind === "subagent-panel") {
    return <Bot className="w-3.5 h-3.5 text-blue-400 shrink-0" />;
  }

  // 文件 Tab：按扩展名解析
  const title = (tab.title || "").toLowerCase();
  if (title.endsWith(".vue")) {
    return <span className="text-emerald-400 font-bold text-[10px] shrink-0">V</span>;
  }
  if (title.endsWith(".js") || title.endsWith(".jsx")) {
    return (
      <span className="bg-amber-400 text-black px-0.5 rounded-[2px] font-bold text-[8px] shrink-0">
        JS
      </span>
    );
  }
  if (title.endsWith(".ts") || title.endsWith(".tsx")) {
    return (
      <span className="bg-blue-500 text-white px-0.5 rounded-[2px] font-bold text-[8px] shrink-0">
        TS
      </span>
    );
  }
  if (title.endsWith(".py")) {
    return <span className="text-blue-400 font-bold text-[9px] shrink-0">PY</span>;
  }
  if (title.endsWith(".sql")) {
    return <span className="text-purple-400 font-bold text-[9px] shrink-0">SQL</span>;
  }
  if (title.endsWith(".md")) {
    return <span className="text-sky-400 font-bold text-[9px] shrink-0">M↓</span>;
  }
  return <FileCode className="w-3.5 h-3.5 text-blue-400 shrink-0" />;
}

export function RightSidebar() {
  const { isRightSidebarOpen, toggleRightSidebar } = useUIStore();
  const {
    tabs,
    activeTabId,
    setActiveTabId,
    closeTab,
    openNewTab,
    openFileInExplorer,
    reorderTabs,
    isFullscreen,
    isMaximized,
    setIsMaximized,
    savedWidthBeforeMaximize,
    setSavedWidthBeforeMaximize,
  } = useWorkbenchStore();

  const { drawerWidth, customWidthPx, setCustomWidthPx, setDrawerWidth } = useCanvasStore();

  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(customWidthPx || 260);

  // Tab 拖拽调整前后顺序状态
  const [draggedTabIndex, setDraggedTabIndex] = useState<number | null>(null);
  const [dragOverTabIndex, setDragOverTabIndex] = useState<number | null>(null);

  const handleTabDragStart = (e: React.DragEvent, index: number) => {
    setDraggedTabIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", index.toString());
  };

  const handleTabDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverTabIndex !== index) {
      setDragOverTabIndex(index);
    }
  };

  const handleTabDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (draggedTabIndex !== null && draggedTabIndex !== targetIndex) {
      reorderTabs(draggedTabIndex, targetIndex);
    }
    setDraggedTabIndex(null);
    setDragOverTabIndex(null);
  };

  const handleTabDragEnd = () => {
    setDraggedTabIndex(null);
    setDragOverTabIndex(null);
  };

  // 最大化覆盖对话框与还原切换
  const handleToggleMaximize = useCallback(() => {
    if (!isMaximized) {
      setSavedWidthBeforeMaximize(customWidthPx || 260);
      setIsMaximized(true);
    } else {
      setIsMaximized(false);
      setCustomWidthPx(savedWidthBeforeMaximize || 260);
    }
  }, [
    isMaximized,
    customWidthPx,
    savedWidthBeforeMaximize,
    setIsMaximized,
    setSavedWidthBeforeMaximize,
    setCustomWidthPx,
  ]);

  // 监听 Esc 键退出最大化
  useEffect(() => {
    if (!isMaximized) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleToggleMaximize();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMaximized, handleToggleMaximize]);

  // 收起侧边栏时自动退出最大化
  const handleCloseSidebar = () => {
    if (isMaximized) {
      setIsMaximized(false);
    }
    toggleRightSidebar();
  };

  useEffect(() => {
    if (isMaximized) return;
    // 默认保持最小宽度 260px，不再强制上限回缩，允许用户自由拉大
    if (!customWidthPx || customWidthPx < 260) {
      setCustomWidthPx(260);
    }
  }, [customWidthPx, isMaximized, setCustomWidthPx]);

  // 左右拖拽拉伸 (支持中间对话框达到 400px 最小宽度时直接吸附最大化)
  const handleMouseDownResize = (e: React.MouseEvent) => {
    e.preventDefault();
    if (drawerWidth !== "normal") {
      setDrawerWidth("normal");
    }
    isDraggingRef.current = true;
    setIsDragging(true);
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = customWidthPx || 260;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const cleanupDrag = () => {
      isDraggingRef.current = false;
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const deltaX = dragStartXRef.current - moveEvent.clientX;
      const targetWidth = dragStartWidthRef.current + deltaX;

      // 实时检测中间对话框的可用空间
      const chatContainer = document.getElementById("main-chat-container");
      const chatRect = chatContainer?.getBoundingClientRect();
      const currentChatWidth = chatRect ? chatRect.width : (window.innerWidth - targetWidth - 240);

      // 吸附临界值：当向左拉大右侧栏导致中间对话框被压缩到最小宽度极限(<=400px)时，直接吸附最大化覆盖对话框
      if (deltaX > 0 && currentChatWidth <= 405) {
        setSavedWidthBeforeMaximize(dragStartWidthRef.current || 520);
        setIsMaximized(true);
        cleanupDrag();
        return;
      }

      // 正常宽度更新
      const maxAllowed =
        typeof window !== "undefined"
          ? Math.max(260, window.innerWidth - 64)
          : 1920;
      const newWidth = Math.max(260, Math.min(maxAllowed, targetWidth));
      setCustomWidthPx(newWidth);
    };

    const handleMouseUp = () => {
      cleanupDrag();
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  // 侧边栏宽度样式计算
  let containerStyle: React.CSSProperties = {};
  if (!isRightSidebarOpen) {
    // 由 className "w-0 pointer-events-none" 控制
  } else if (isFullscreen || drawerWidth === "fullscreen") {
    // 全屏时样式由 fixed inset-0 控制，清除内联宽度避免冲突
    containerStyle = {};
  } else if (isMaximized) {
    // 覆盖整个对话框区域：因兄弟主聊天区已隐藏，右侧栏自然占据 100% 宽度，零重排零闪烁
    containerStyle = {
      width: "100%",
      flex: "1 1 0%",
    };
  } else {
    // 正常模式：支持自由拉伸至全屏可用宽度
    containerStyle = {
      width: `${customWidthPx || 260}px`,
      maxWidth: "calc(100vw - 64px)",
    };
  }

  return (
    <aside
      style={containerStyle}
      className={`${
        isFullscreen || drawerWidth === "fullscreen"
          ? "fixed inset-0 z-50 w-full h-full"
          : isMaximized
          ? "relative z-30 w-full h-full flex-1"
          : "relative h-full"
      } flex flex-col bg-[#161618] border-l border-white/[0.06] text-[#ECECED] select-none overflow-hidden ${
        isDragging || isMaximized ? "transition-none select-none" : "transition-[width] duration-200 ease-out"
      } flex-shrink-0 shadow-2xl ${
        !isRightSidebarOpen ? "w-0 pointer-events-none border-none" : ""
      }`}
    >
      {/* 1. 左侧自由拉伸把手 (最大化覆盖对话框时隐藏) */}
      {isRightSidebarOpen && !isMaximized && !isFullscreen && drawerWidth !== "fullscreen" && (
        <div
          onMouseDown={handleMouseDownResize}
          onDoubleClick={handleToggleMaximize}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500 transition-colors z-40 group"
          title="按住左右拖拽调整宽度 / 双击放大覆盖对话框"
        >
          <div className="absolute left-0.5 top-1/2 -translate-y-1/2 w-0.5 h-8 bg-[#444448] group-hover:bg-blue-400 rounded-full" />
        </div>
      )}

      {/* 2. 顶部主标签栏 (支持多Tab切页、X关闭、+新建[文件、浏览器、终端]) */}
      <div className="h-11 px-2.5 bg-[#161618] border-b border-white/[0.06] flex items-center justify-between shrink-0 gap-2">
        {/* Tab 列表与新建下拉按钮 */}
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none flex-1 py-1 min-w-0">
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeTabId;
            const canClose = !(tabs.length === 1 && tab.kind === "new-tab");
            const isBeingDragged = draggedTabIndex === index;
            const isDragOver = dragOverTabIndex === index && draggedTabIndex !== index;
            const isFileTab = tab.kind === "file-explorer";

            return (
              <div
                key={tab.id}
                draggable={true}
                onDragStart={(e) => handleTabDragStart(e, index)}
                onDragOver={(e) => handleTabDragOver(e, index)}
                onDrop={(e) => handleTabDrop(e, index)}
                onDragEnd={handleTabDragEnd}
                onClick={() => setActiveTabId(tab.id)}
                className={`group relative flex items-center gap-2 h-8 px-3 rounded-lg text-xs cursor-pointer select-none transition-all duration-150 shrink-0 min-w-[92px] max-w-[210px] ${
                  isActive
                    ? "bg-[#2D2D30] text-white font-medium shadow-sm"
                    : "bg-transparent text-[#9E9EA4] hover:text-white hover:bg-white/[0.04]"
                } ${isBeingDragged ? "opacity-30 scale-95" : "opacity-100"} ${
                  isDragOver ? "border-l-2 border-blue-500 bg-white/[0.08]" : ""
                }`}
                title={tab.title}
              >
                {/* 1. 左侧插槽：
                    - 文件 Tab: 默认展示文件类型图标，鼠标悬停时原位展示 X 关闭按钮
                    - 非文件 Tab: 常显对应类型图标 (如小地球 Globe、终端等)
                */}
                <div className="relative w-4 h-4 flex items-center justify-center shrink-0">
                  {isFileTab && canClose ? (
                    <>
                      <span className="flex items-center justify-center group-hover:opacity-0 transition-opacity">
                        {getTabIcon(tab)}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(tab.id);
                        }}
                        className="absolute inset-0 flex items-center justify-center rounded text-[#8E8E93] hover:text-white hover:bg-white/20 opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
                        title="关闭文件"
                      >
                        <X className="w-3.5 h-3.5 stroke-[1.8]" />
                      </button>
                    </>
                  ) : (
                    <span className={`flex items-center justify-center ${isActive ? "text-white" : "text-[#9E9EA4]"}`}>
                      {getTabIcon(tab)}
                    </span>
                  )}
                </div>

                {/* 2. 中间自适应标题 */}
                <span className="truncate flex-1 font-sans text-xs">
                  {tab.title}
                </span>

                {/* 3. 右侧关闭按钮：
                    - 文件 Tab: 关闭按钮已置于左侧，右侧不展示
                    - 非文件 Tab: 关闭按钮置于右侧 (对标截图中的 [🌐 新标签页   x])
                */}
                {!isFileTab && canClose && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    className={`shrink-0 p-0.5 rounded text-[#8E8E93] hover:text-white hover:bg-white/20 transition-all cursor-pointer ${
                      isActive ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-100"
                    }`}
                    title="关闭标签页"
                  >
                    <X className="w-3.5 h-3.5 stroke-[1.8]" />
                  </button>
                )}
              </div>
            );
          })}

          {/* '+' 按钮新建标签页 */}
          <button
            type="button"
            onClick={openNewTab}
            className="p-1 rounded text-[#8E8E93] hover:text-white hover:bg-white/10 transition-colors cursor-pointer shrink-0 ml-0.5"
            title="新建标签页"
          >
            <Plus className="w-4 h-4 stroke-[1.8]" />
          </button>
        </div>

        {/* 右侧动作按钮: 放大/还原、收起侧边栏 */}
        <div className="flex items-center gap-0.5 shrink-0 text-[#8E8E93]">
          {/* 1. 放大 / 还原 (覆盖整个对话框区域) */}
          <div className="relative group/tip">
            <button
              type="button"
              onClick={handleToggleMaximize}
              className="p-1.5 rounded hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              {isMaximized ? (
                <Minimize2 className="w-3.5 h-3.5 text-blue-400" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )}
            </button>
            <div className="pointer-events-none absolute top-full mt-1.5 right-0 hidden group-hover/tip:flex items-center px-2 py-0.5 rounded bg-zinc-900 border border-white/10 text-[10px] text-white whitespace-nowrap z-50 shadow-lg">
              {isMaximized ? "还原视图 (Esc)" : "放大覆盖对话框"}
            </div>
          </div>

          {/* 2. 收起侧边栏 */}
          <div className="relative group/tip">
            <button
              type="button"
              onClick={handleCloseSidebar}
              className="p-1.5 rounded hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            >
              <PanelRightClose className="w-3.5 h-3.5" />
            </button>
            <div className="pointer-events-none absolute top-full mt-1.5 right-0 hidden group-hover/tip:flex items-center px-2 py-0.5 rounded bg-zinc-900 border border-white/10 text-[10px] text-white whitespace-nowrap z-50 shadow-lg">
              收起侧边栏
            </div>
          </div>
        </div>
      </div>

      {/* 3. 多态并发视口舞台 (采用 CSS hidden 保持挂载，保证每个 Tab 的终端、代码和浏览器状态不丢失) */}
      <div className="flex-1 min-h-0 relative overflow-hidden bg-[#161618]">
        {tabs.map((tab) => {
          const isCurrent = tab.id === activeTabId;

          return (
            <div
              key={tab.id}
              className={`w-full h-full ${isCurrent ? "block" : "hidden"}`}
            >
              {tab.kind === "new-tab" && (
                <NewTabView tabId={tab.id} />
              )}

              {tab.kind === "file-explorer" && (
                <FileExplorerTabView
                  selectedFilePath={tab.selectedFilePath}
                  onSelectFile={(path, content, name) => {
                    openFileInExplorer({
                      filePath: path,
                      title: name || path.split("/").pop(),
                      content: content || "",
                    });
                  }}
                />
              )}

              {tab.kind === "browser" && (
                <BrowserTabView initialUrl={tab.url} />
              )}

              {tab.kind === "changes" && (
                <ChangesTabView
                  turnIndex={tab.activeTurnIndex}
                  totalAdditions={tab.totalAdditions}
                  totalDeletions={tab.totalDeletions}
                  diffFiles={tab.diffFiles}
                  selectedFilePath={tab.selectedFilePath}
                />
              )}

              {tab.kind === "terminal" && (
                <TerminalTabView sessionId={tab.sessionId} />
              )}

              {tab.kind === "subagent-panel" && (
                <SubagentTabView tab={tab} />
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
