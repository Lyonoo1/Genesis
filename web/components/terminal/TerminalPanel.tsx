"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Terminal as TerminalIcon,
  Plus,
  X,
  Trash2,
  RotateCcw,
  Maximize2,
  Minimize2,
  ChevronDown,
} from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import { useUIStore } from "@/stores/useUIStore";
import { XtermCanvas } from "./XtermCanvas";
import { restartTerminalSession, deleteTerminalSession } from "@/lib/api/terminal";

interface TabItem {
  id: string;
  title: string;
}

export function TerminalPanel() {
  const {
    isTerminalOpen,
    closeTerminal,
    terminalHeight,
    setTerminalHeight,
  } = useUIStore();

  const tabCounterRef = useRef(1);
  const [tabs, setTabs] = useState<TabItem[]>([
    { id: "default", title: "终端 1" },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>("default");
  const [statuses, setStatuses] = useState<
    Record<string, "connected" | "connecting" | "disconnected">
  >({});
  const [isMaximized, setIsMaximized] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [hasBeenOpened, setHasBeenOpened] = useState(false);

  useEffect(() => {
    if (isTerminalOpen) {
      setHasBeenOpened(true);
    }
  }, [isTerminalOpen]);

  // 保存每个 Tab 对应的 xterm 实例引用，便于触发清屏
  const termInstancesRef = useRef<Record<string, Terminal | null>>({});

  const handleStatusChange = useCallback(
    (tabId: string, st: "connected" | "connecting" | "disconnected") => {
      setStatuses((prev) => {
        if (prev[tabId] === st) return prev;
        return { ...prev, [tabId]: st };
      });
    },
    []
  );

  const handleRegisterTerm = useCallback(
    (tabId: string, term: Terminal | null) => {
      termInstancesRef.current[tabId] = term;
    },
    []
  );

  // 记录拖拽拉伸
  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(terminalHeight);

  const handleMouseDownResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartYRef.current = e.clientY;
    dragStartHeightRef.current = terminalHeight;
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = dragStartYRef.current - e.clientY;
      const minHeight = 160;
      const maxHeight = window.innerHeight * 0.85;
      const target = Math.min(Math.max(minHeight, dragStartHeightRef.current + deltaY), maxHeight);
      setTerminalHeight(target);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, setTerminalHeight]);

  // 新建终端会话标签
  const handleAddTab = () => {
    tabCounterRef.current += 1;
    const newId = `session-${Date.now().toString(36)}-${tabCounterRef.current}`;
    const newTitle = `终端 ${tabCounterRef.current}`;
    setTabs((prev) => [...prev, { id: newId, title: newTitle }]);
    setActiveTabId(newId);
  };

  // 关闭指定终端标签并通知后端销毁进程组
  const handleCloseTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) {
      handleRestartActiveTab();
      return;
    }

    // 联动后端销毁该会话及其子进程组，杜绝孤儿进程泄漏
    deleteTerminalSession(tabId).catch((err) => {
      console.warn("Failed to delete terminal session", tabId, err);
    });

    delete termInstancesRef.current[tabId];

    setTabs((prev) => {
      const filtered = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        const closedIdx = prev.findIndex((t) => t.id === tabId);
        const nextTab = filtered[Math.max(0, closedIdx - 1)] || filtered[0];
        setActiveTabId(nextTab.id);
      }
      return filtered;
    });
  };

  // 清屏
  const handleClear = () => {
    const activeTerm = termInstancesRef.current[activeTabId];
    if (activeTerm) {
      activeTerm.clear();
    }
  };

  // 重启当前会话
  const handleRestartActiveTab = async () => {
    const activeTerm = termInstancesRef.current[activeTabId];
    if (activeTerm) {
      activeTerm.writeln("\r\n\x1b[36m[正在重启终端会话...]\x1b[0m\r\n");
    }
    try {
      await restartTerminalSession(activeTabId);
    } catch (err) {
      console.error("Failed to restart terminal session", err);
    }
  };

  const currentStatus = statuses[activeTabId] || "connecting";

  const effectiveHeight = isMaximized ? "calc(100vh - 44px)" : `${terminalHeight}px`;

  return (
    <div
      className={`relative w-full flex-col bg-[#141416] border-t border-[#2A2A2E] z-30 transition-[height] duration-150 ease-out flex-shrink-0 ${
        isTerminalOpen ? "flex" : "hidden"
      }`}
      style={{ height: effectiveHeight }}
    >
      {/* 拖拽时的全屏防穿透遮罩 */}
      {isDragging && (
        <div className="fixed inset-0 z-50 cursor-ns-resize select-none" />
      )}

      {/* 顶部拖拽把手 (Drag handle) */}
      <div
        onMouseDown={handleMouseDownResize}
        onDoubleClick={() => setIsMaximized(!isMaximized)}
        className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize hover:bg-emerald-500/50 transition-colors z-40 select-none group flex items-center justify-center"
        title="按住上下拖拽调整高度，双击切换最大化"
      >
        <div className="w-10 h-0.5 rounded-full bg-white/20 group-hover:bg-emerald-400 transition-colors" />
      </div>

      {/* 控制顶栏 */}
      <div className="h-9 px-3 flex items-center justify-between border-b border-[#242428] bg-[#18181B] select-none text-xs text-[#8E8E93] shrink-0">
        {/* 左侧：图标 + 会话标签列表 + 状态指示灯 */}
        <div className="flex items-center gap-2 min-w-0 overflow-x-auto scrollbar-none py-1">
          <div className="flex items-center gap-1.5 text-white font-medium shrink-0 pr-1 border-r border-[#2A2A2E]">
            <TerminalIcon className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-[11px] tracking-wide">终端</span>
          </div>

          {/* 会话 Tab 列表 */}
          <div className="flex items-center gap-1">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  onClick={() => setActiveTabId(tab.id)}
                  className={`group/tab flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] transition-all cursor-pointer border ${
                    isActive
                      ? "bg-[#252529] text-white border-white/10 font-medium shadow-sm"
                      : "bg-transparent text-[#8E8E93] border-transparent hover:text-white hover:bg-white/[0.04]"
                  }`}
                >
                  <span>{tab.title}</span>
                  {tabs.length > 1 && (
                    <button
                      type="button"
                      onClick={(e) => handleCloseTab(tab.id, e)}
                      className="opacity-0 group-hover/tab:opacity-100 hover:text-red-400 transition-opacity p-0.5 rounded"
                      title="关闭终端"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  )}
                </div>
              );
            })}

            {/* 新建终端 Tab 按钮 */}
            <button
              type="button"
              onClick={handleAddTab}
              className="p-1 rounded hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
              title="新建终端会话"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>

          {/* 连接状态指示 */}
          <div className="flex items-center gap-1.5 ml-2 text-[10px]">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                currentStatus === "connected"
                  ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]"
                  : currentStatus === "connecting"
                  ? "bg-amber-400 animate-pulse"
                  : "bg-red-400"
              }`}
            />
            <span className="text-[#71717A]">
              {currentStatus === "connected"
                ? "已就绪"
                : currentStatus === "connecting"
                ? "连接中"
                : "已断开"}
            </span>
          </div>
        </div>

        {/* 右侧：快捷工具组 (清屏、重启、最大化、关闭) */}
        <div className="flex items-center gap-1 text-[#8E8E93]">
          <button
            type="button"
            onClick={handleClear}
            className="p-1.5 rounded hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
            title="清屏 (Clear)"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={handleRestartActiveTab}
            className="p-1.5 rounded hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
            title="重启终端会话 (Restart)"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => setIsMaximized(!isMaximized)}
            className="p-1.5 rounded hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
            title={isMaximized ? "还原尺寸" : "最大化终端"}
          >
            {isMaximized ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>

          <button
            type="button"
            onClick={closeTerminal}
            className="p-1.5 rounded hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
            title="收起终端 (^`)"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 终端内容视口容器：各 Tab 仅在首次打开后常驻挂载，杜绝初始化建立无谓的 WebSocket 争抢 */}
      <div className="flex-1 w-full relative overflow-hidden bg-[#121214]">
        {(hasBeenOpened || isTerminalOpen) &&
          tabs.map((tab) => (
            <div
              key={tab.id}
              className="w-full h-full"
              style={{
                display: tab.id === activeTabId ? "block" : "none",
              }}
            >
              <XtermCanvas
                sessionId={tab.id}
                isVisible={isTerminalOpen && tab.id === activeTabId}
                onStatusChange={(st) => handleStatusChange(tab.id, st)}
                onRegisterTerm={(term) => handleRegisterTerm(tab.id, term)}
              />
            </div>
          ))}
      </div>
    </div>
  );
}
