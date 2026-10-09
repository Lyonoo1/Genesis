"use client";

import React, { useEffect, useRef } from "react";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { QuickNavSection } from "./QuickNavSection";
import { ProjectTree } from "./ProjectTree";
import { ProfileFooter } from "./ProfileFooter";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { HistorySearchModal } from "./HistorySearchModal";
import { StopAndArchiveModal } from "./StopAndArchiveModal";
import { ArchiveToast } from "./ArchiveToast";
import { DeleteProjectModal } from "./DeleteProjectModal";
import { useSessionStore } from "@/stores/useSessionStore";
import { useModelConfigStore } from "@/stores/useModelConfigStore";
import { useUIStore } from "@/stores/useUIStore";

interface SidebarProps {
  onSidebarMouseEnter?: () => void;
  onSidebarMouseLeave?: () => void;
}

export function Sidebar({
  onSidebarMouseEnter,
  onSidebarMouseLeave,
}: SidebarProps) {
  const { fetchSessions } = useSessionStore();
  const { fetchModels } = useModelConfigStore();
  const {
    isLeftSidebarOpen,
    isLeftSidebarHovered,
    setLeftSidebarHovered,
  } = useUIStore();

  const localHoverTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    fetchSessions();
    fetchModels();
  }, [fetchSessions, fetchModels]);

  const handleMouseEnter = () => {
    if (onSidebarMouseEnter) {
      onSidebarMouseEnter();
      return;
    }
    if (localHoverTimerRef.current) {
      clearTimeout(localHoverTimerRef.current);
      localHoverTimerRef.current = null;
    }
    if (!isLeftSidebarOpen) {
      setLeftSidebarHovered(true);
    }
  };

  const handleMouseLeave = () => {
    if (onSidebarMouseLeave) {
      onSidebarMouseLeave();
      return;
    }
    if (!isLeftSidebarOpen) {
      if (localHoverTimerRef.current) clearTimeout(localHoverTimerRef.current);
      localHoverTimerRef.current = setTimeout(() => {
        setLeftSidebarHovered(false);
      }, 200);
    }
  };

  const isHoverFloating = !isLeftSidebarOpen && isLeftSidebarHovered;

  return (
    <>
      {/* 1. 文档流占位容器：实现固定展开时的平滑宽度推拉动画 (时长增加 0.2s 至 600ms) */}
      <div
        className={`h-full flex-shrink-0 overflow-hidden transition-[width] duration-[600ms] ease-out select-none ${
          isLeftSidebarOpen ? "w-[260px]" : "w-0"
        }`}
      />

      {/* 
        2. 侧边栏实体：
        - 容器常驻纯黑底色 bg-[#161618]，鼠标 hover 滑出时呈现黑色无阴影；
        - 点击正式打开时，内部灰色质感层从左向右平滑滑入，动画时长 600ms 与侧栏完全同步。
      */}
      <aside
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className={`fixed left-0 top-0 bottom-0 w-[260px] flex flex-col select-none h-full overflow-hidden transition-all duration-[600ms] ease-out bg-[#161618] ${
          isHoverFloating
            ? "z-40 translate-x-0 border-r border-[#27272A] shadow-none"
            : isLeftSidebarOpen
            ? "z-30 translate-x-0 border-r border-[#323232] shadow-none"
            : "z-30 -translate-x-full pointer-events-none border-r border-[#27272A] shadow-none"
        }`}
      >
        {/* 灰色质感背景层：黑色背景转为灰色背景的动画时长单独设成 200ms 从左向右滑入展开 */}
        <div
          className={`absolute inset-0 pointer-events-none transition-transform duration-[200ms] ease-out bg-gradient-to-b from-[#292A2E] via-[#262628] to-[#262628] border-r border-[#323232] z-0 ${
            isLeftSidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        />

        {/* 侧边栏内容区：z-10 始终悬浮于黑色/灰色底色之上 */}
        <div className="relative z-10 flex flex-col h-full overflow-hidden">
          {/* 1. 工作区头部（左侧 Genesis 标识） */}
          <WorkspaceHeader />

          {/* 2. 快速导航区（新对话、插件） */}
          <QuickNavSection />

          {/* 3. 项目与会话展开树 */}
          <ProjectTree />

          {/* 4. 底部个人信息胶囊与弹出菜单 */}
          <ProfileFooter />
        </div>
      </aside>

      {/* 5. 历史记录与已归档搜索弹窗 (⌘K) */}
      <HistorySearchModal />

      {/* 6. 正在对话时的停止并归档提示弹窗 */}
      <StopAndArchiveModal />

      {/* 7. 删除项目二次确认弹窗 */}
      <DeleteProjectModal />

      {/* 8. 会话二次确认删除弹窗 */}
      <DeleteConfirmModal />

      {/* 9. 归档后撤销浮动提示 Toast */}
      <ArchiveToast />
    </>
  );
}
