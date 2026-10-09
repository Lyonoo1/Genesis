"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  SquarePen,
  Folder,
  Search,
} from "lucide-react";
import { useSessionStore } from "@/stores/useSessionStore";
import { useUIStore } from "@/stores/useUIStore";
import { Session } from "@/types";

export function HistorySearchModal() {
  const router = useRouter();
  const {
    isHistoryModalOpen,
    closeHistoryModal,
    sessions,
    projects,
    setActiveSessionId,
    setActiveProjectId,
    startNewChat,
  } = useSessionStore();

  const { openRightSidebar } = useUIStore();

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 映射项目名称方便展示右侧标识
  const projectMap = useMemo(() => {
    const map = new Map<string, string>();
    projects.forEach((p) => {
      if (p?.id && p?.name) {
        map.set(p.id, p.name);
      }
    });
    return map;
  }, [projects]);

  // 过滤会话列表（按时间排序，非归档会话优先）
  const matchedSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const sorted = [...(sessions || [])].sort((a, b) => {
      return (
        new Date(b.updated_at || b.created_at).getTime() -
        new Date(a.updated_at || a.created_at).getTime()
      );
    });

    if (!query) {
      return sorted.slice(0, 8);
    }

    return sorted
      .filter((s) => {
        if (!s) return false;
        const titleMatch = s.title?.toLowerCase().includes(query) ?? false;
        const projName = s.project_id
          ? projectMap.get(s.project_id)?.toLowerCase() || ""
          : "";
        return titleMatch || projName.includes(query);
      })
      .slice(0, 8);
  }, [sessions, searchQuery, projectMap]);

  // 快捷操作项配置 (1:1 对标图二)
  const quickActions = useMemo(
    () => [
      {
        id: "new-chat",
        title: "新聊天",
        icon: SquarePen,
        shortcut: "⌘N",
        action: () => {
          startNewChat();
          closeHistoryModal();
          router.push("/chat");
        },
      },
      {
        id: "open-folder",
        title: "打开文件夹",
        icon: Folder,
        shortcut: "⌘O",
        action: () => {
          closeHistoryModal();
          if (projects.length > 0) {
            setActiveProjectId(projects[0].id);
          }
          router.push("/chat");
        },
      },
      {
        id: "search-files",
        title: "搜索文件",
        icon: Search,
        shortcut: "⌘P",
        action: () => {
          closeHistoryModal();
          openRightSidebar("preview");
        },
      },
    ],
    [closeHistoryModal, openRightSidebar, projects, router, setActiveProjectId, startNewChat]
  );

  // 所有可被键盘选中的条目总数
  const totalItemsCount = matchedSessions.length + quickActions.length;

  // 重置状态
  useEffect(() => {
    if (isHistoryModalOpen) {
      setSearchQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isHistoryModalOpen]);

  // 当搜索关键词变化时，将光标定位回第 0 项
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  const handleSelectSession = (session: Session) => {
    if (session.project_id) {
      setActiveProjectId(session.project_id);
    }
    setActiveSessionId(session.id);
    closeHistoryModal();
    router.push(`/chat/${session.id}`);
  };

  // 全局键盘导航与快捷键
  useEffect(() => {
    if (!isHistoryModalOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      // 1. 关闭弹窗
      if (e.key === "Escape") {
        e.preventDefault();
        closeHistoryModal();
        return;
      }

      // 2. 上下方向键移动光标
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % (totalItemsCount || 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev - 1 < 0 ? Math.max(0, totalItemsCount - 1) : prev - 1
        );
        return;
      }

      // 3. 回车执行当前高亮项
      if (e.key === "Enter") {
        e.preventDefault();
        if (selectedIndex < matchedSessions.length) {
          const target = matchedSessions[selectedIndex];
          if (target) handleSelectSession(target);
        } else {
          const actionIndex = selectedIndex - matchedSessions.length;
          const action = quickActions[actionIndex];
          if (action) action.action();
        }
        return;
      }

      // 4. 支持 ⌘1 ~ ⌘9 快速跳入前 9 个会话
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const num = parseInt(e.key, 10);
        const target = matchedSessions[num - 1];
        if (target) {
          handleSelectSession(target);
        }
        return;
      }

      // 5. 支持 ⌘N (新聊天)、⌘O (打开文件夹)、⌘P (搜索文件)
      if (e.metaKey || e.ctrlKey) {
        const key = e.key.toLowerCase();
        if (key === "n") {
          e.preventDefault();
          quickActions[0].action();
        } else if (key === "o") {
          e.preventDefault();
          quickActions[1].action();
        } else if (key === "p") {
          e.preventDefault();
          quickActions[2].action();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isHistoryModalOpen,
    closeHistoryModal,
    totalItemsCount,
    selectedIndex,
    matchedSessions,
    quickActions,
  ]);

  if (!isHistoryModalOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[999] flex justify-center items-start pt-[12vh] p-4 bg-black/60 backdrop-blur-sm select-none animate-in fade-in duration-150"
      onClick={closeHistoryModal}
    >
      {/* 弹窗主体容器：对标截图 2 的圆角与深黑质感 */}
      <div
        className="w-[490px] max-w-[94vw] bg-[#1C1C1E] border border-[#2E2E33] rounded-2xl shadow-[0_24px_64px_rgba(0,0,0,0.8)] p-2 flex flex-col overflow-hidden animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 1. 顶部搜索输入框 (无明显边框，光标闪烁，占位符: 搜索聊天) */}
        <div className="px-2 pt-1 pb-1.5">
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索聊天"
            className="w-full bg-transparent text-[13px] text-white placeholder-[#71717A] outline-none px-2 py-1.5 caret-blue-400"
          />
        </div>

        {/* 2. 聊天分组 */}
        <div className="space-y-0.5 pt-1">
          <div className="px-3 py-1 text-[11px] font-medium text-[#71717A]">
            聊天
          </div>

          <div className="space-y-0.5 max-h-[300px] overflow-y-auto">
            {matchedSessions.length === 0 ? (
              <div className="px-3 py-3 text-center text-xs text-[#71717A]">
                未找到匹配的聊天
              </div>
            ) : (
              matchedSessions.map((s, idx) => {
                const isSelected = selectedIndex === idx;
                const projName = s.project_id
                  ? projectMap.get(s.project_id) || "chat"
                  : "chat";
                const projShort =
                  projName.length > 8 ? projName.slice(0, 6) + ".." : projName;
                const shortcut = idx < 9 ? `⌘${idx + 1}` : null;

                return (
                  <div
                    key={s.id}
                    onClick={() => handleSelectSession(s)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`px-3 py-2 rounded-xl flex items-center justify-between text-xs cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-white/[0.08] text-white"
                        : "text-[#ECECED] hover:bg-white/[0.04]"
                    }`}
                  >
                    <span className="truncate max-w-[280px] font-normal">
                      {s.title}
                    </span>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] text-[#71717A] font-mono">
                        {projShort}
                      </span>
                      {shortcut && (
                        <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono text-[#8E8E93] bg-white/[0.06] border border-white/[0.04] min-w-[24px] text-center">
                          {shortcut}
                        </kbd>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 3. 快捷操作分组 (图二底部) */}
        <div className="space-y-0.5 pt-2">
          <div className="px-3 py-1 text-[11px] font-medium text-[#71717A]">
            快捷操作
          </div>

          <div className="space-y-0.5">
            {quickActions.map((action, actionIdx) => {
              const itemGlobalIndex = matchedSessions.length + actionIdx;
              const isSelected = selectedIndex === itemGlobalIndex;
              const Icon = action.icon;

              return (
                <div
                  key={action.id}
                  onClick={action.action}
                  onMouseEnter={() => setSelectedIndex(itemGlobalIndex)}
                  className={`px-3 py-2 rounded-xl flex items-center justify-between text-xs cursor-pointer transition-colors ${
                    isSelected
                      ? "bg-white/[0.08] text-white"
                      : "text-[#ECECED] hover:bg-white/[0.04]"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className="w-3.5 h-3.5 text-[#8E8E93]" />
                    <span>{action.title}</span>
                  </div>

                  <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono text-[#8E8E93] bg-white/[0.06] border border-white/[0.04] min-w-[24px] text-center">
                    {action.shortcut}
                  </kbd>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
