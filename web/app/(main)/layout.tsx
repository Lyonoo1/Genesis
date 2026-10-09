"use client";

import React, { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Folder, PanelRight, PanelRightClose, PanelLeft, PanelLeftOpen, Search } from "lucide-react";
import { useSessionStore } from "@/stores/useSessionStore";
import { useChatStore } from "@/stores/useChatStore";
import { useUIStore } from "@/stores/useUIStore";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { RightSidebar } from "@/components/inspector/RightSidebar";
import { supabase } from "@/lib/supabase/client";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname() || "";
  const { sessions, activeSessionId, openHistoryModal } = useSessionStore();
  const {
    isRightSidebarOpen,
    toggleRightSidebar,
    isLeftSidebarOpen,
    toggleLeftSidebar,
    setLeftSidebarHovered,
  } = useUIStore();

  // 双向互锁防抖，彻底消除 Hover 抽搐抖动
  const isHoveringButtonRef = useRef(false);
  const isHoveringSidebarRef = useRef(false);
  const closeTimerRef = useRef<NodeJS.Timeout | null>(null);

  const currentSessionId = pathname.startsWith("/chat/")
    ? pathname.replace("/chat/", "")
    : activeSessionId;

  const activeSession = (sessions || []).find(
    (s) => s && s.id === currentSessionId && !s.is_archived
  );

  // 保持滑动无感续期与多账号切换数据隔离，并监听跨 Tab 登出广播
  useEffect(() => {
    const handleRemoteLogout = () => {
      useSessionStore.getState().resetSessionStore();
      useChatStore.getState().resetChatStore();
      localStorage.removeItem("genesis_auth_token");
      document.cookie =
        "genesis_auth_token=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax";
      window.location.href = "/login";
    };

    // 1. 原生跨标签页通信：BroadcastChannel
    let bc: BroadcastChannel | null = null;
    try {
      if (typeof window !== "undefined" && window.BroadcastChannel) {
        bc = new BroadcastChannel("genesis_auth_channel");
        bc.onmessage = (event) => {
          if (event.data?.type === "LOGOUT") {
            handleRemoteLogout();
          }
        };
      }
    } catch {}

    // 2. 备用跨标签页通信：StorageEvent 监听
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "genesis_logout_timestamp" || (e.key === "genesis_auth_token" && !e.newValue)) {
        handleRemoteLogout();
      }
    };
    window.addEventListener("storage", handleStorage);

    // 3. Supabase Auth 状态订阅
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (session?.access_token) {
        localStorage.setItem("genesis_auth_token", session.access_token);
        const maxAge = session.expires_in || 604800;
        const isHttps =
          typeof window !== "undefined" && window.location.protocol === "https:";
        document.cookie = `genesis_auth_token=${encodeURIComponent(
          session.access_token
        )}; path=/; max-age=${maxAge}; SameSite=Lax; ${isHttps ? "Secure;" : ""}`;
      } else if (event === "SIGNED_OUT") {
        handleRemoteLogout();
      }
    });

    return () => {
      subscription.unsubscribe();
      window.removeEventListener("storage", handleStorage);
      if (bc) {
        bc.close();
      }
    };
  }, [router]);


  // 鼠标进入切换按钮
  const handleButtonMouseEnter = () => {
    isHoveringButtonRef.current = true;
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (!isLeftSidebarOpen) {
      setLeftSidebarHovered(true);
    }
  };

  // 鼠标离开切换按钮
  const handleButtonMouseLeave = () => {
    isHoveringButtonRef.current = false;
    if (!isLeftSidebarOpen) {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(() => {
        if (!isHoveringButtonRef.current && !isHoveringSidebarRef.current) {
          setLeftSidebarHovered(false);
        }
      }, 220);
    }
  };

  // 鼠标进入滑出的侧边栏
  const handleSidebarMouseEnter = () => {
    isHoveringSidebarRef.current = true;
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (!isLeftSidebarOpen) {
      setLeftSidebarHovered(true);
    }
  };

  // 鼠标离开滑出的侧边栏
  const handleSidebarMouseLeave = () => {
    isHoveringSidebarRef.current = false;
    if (!isLeftSidebarOpen) {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(() => {
        if (!isHoveringButtonRef.current && !isHoveringSidebarRef.current) {
          setLeftSidebarHovered(false);
        }
      }, 220);
    }
  };

  // 点击切换侧边栏
  const handleToggleClick = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    toggleLeftSidebar();
  };

  // 全局 ⌘, 与 ⌘B 快捷键监听
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        if (pathname.startsWith("/settings")) {
          router.push("/chat");
        } else {
          router.push("/settings");
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleLeftSidebar();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pathname, router, toggleLeftSidebar]);

  // 如果处于 /settings 路由，整页独占渲染 Codex 风格全屏设置页面
  if (pathname.startsWith("/settings")) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#161618] text-[#ECECED] select-none">
      {/* 
        统一物理锚定的切换侧边栏按钮 (z-50)：
        无论侧边栏处于展开还是收起状态，永远精确定位在 left-[220px] top-2，
        - 展开时：正好处于侧边栏右上角搜索图标的右侧；
        - 收起时：依然稳稳座落在同一个绝对物理位置，光标零位移！
      */}
      {/* 
        统一物理锚定的常驻控制组 (z-50)：
        侧边栏按钮 (PanelLeft) 放在最左侧，搜索按钮 (Search) 紧随其后！
        固定在 left-3.5 top-2.5（收起与展开状态光标零位移原地驻留）
      */}
      {pathname !== "/login" && !pathname.startsWith("/marketplace") && (
        <div className="fixed left-3.5 top-2.5 z-50 flex items-center gap-0.5 pointer-events-auto">
          {/* 按钮 1: 切换侧边栏 (PanelLeft ⌘B) - 位于最左侧 */}
          <div className="relative group">
            <button
              type="button"
              onClick={handleToggleClick}
              onMouseEnter={handleButtonMouseEnter}
              onMouseLeave={handleButtonMouseLeave}
              className="w-6 h-6 flex items-center justify-center rounded-md text-[#8E8E93] hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
              aria-label={isLeftSidebarOpen ? "收起侧边栏" : "展开侧边栏"}
            >
              {isLeftSidebarOpen ? (
                <PanelLeft className="w-3.5 h-3.5" />
              ) : (
                <PanelLeftOpen className="w-3.5 h-3.5" />
              )}
            </button>
            {/* Tooltip: 切换侧边栏 ⌘B */}
            <div className="absolute top-full left-0 mt-1.5 hidden group-hover:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#1B1B1F] border border-[#2C2C33] text-[11px] text-white shadow-2xl whitespace-nowrap z-50 pointer-events-none">
              <span>{isLeftSidebarOpen ? "收起侧边栏" : "展开侧边栏"}</span>
              <span className="text-[#8E8E93] font-mono text-[10px]">⌘B</span>
            </div>
          </div>

          {/* 按钮 2: 搜索 (Search ⌘K) */}
          <div className="relative group">
            <button
              type="button"
              onClick={() => openHistoryModal("all")}
              className="w-6 h-6 flex items-center justify-center rounded-md text-[#8E8E93] hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
              aria-label="搜索历史记录与命令"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
            {/* Tooltip: 搜索 ⌘K */}
            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 hidden group-hover:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#1B1B1F] border border-[#2C2C33] text-[11px] text-white shadow-2xl whitespace-nowrap z-50 pointer-events-none">
              <span>搜索</span>
              <span className="text-[#8E8E93] font-mono text-[10px]">⌘K</span>
            </div>
          </div>
        </div>
      )}

      {/* 1. Codex 左侧侧边栏体系 (260px) */}
      <Sidebar
        onSidebarMouseEnter={handleSidebarMouseEnter}
        onSidebarMouseLeave={handleSidebarMouseLeave}
      />

      {/* 2. 主工作区：水平布局 (左侧主聊天区，右侧全高度检查器侧边栏) */}
      <div className="flex-1 flex flex-row min-w-0 h-full overflow-hidden bg-[#161618]">
        {/* 2.1 左侧主内容区 (包含顶部栏与内容舞台) */}
        <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-[#161618]">
          {/* 顶部标题栏：纯黑色调无缝贯通 */}
          {pathname !== "/login" && !pathname.startsWith("/marketplace") && (
            <header
              className={`relative z-10 h-11 px-4 flex items-center shrink-0 bg-[#161618] border-b border-[#27272A]/80 transition-all duration-[600ms] ease-out ${
                isRightSidebarOpen
                  ? "opacity-0 pointer-events-none"
                  : "opacity-100 pointer-events-auto"
              }`}
            >
              {/* 会话信息：收起时紧跟搜索按钮右侧，展开时 margin 归零 */}
              <div
                className={`flex items-center gap-2 min-w-0 transition-[margin] duration-[600ms] ease-out ${
                  !isLeftSidebarOpen ? "ml-[58px]" : "ml-0"
                }`}
              >
                {/* 📁 文件夹图标 + 标题 */}
                <div className="flex items-center gap-2 text-xs font-medium text-white truncate max-w-md">
                  <Folder className="w-3.5 h-3.5 text-codex-muted shrink-0" />
                  <span className="truncate">
                    {activeSession ? activeSession.title : "新对话"}
                  </span>
                </div>

              </div>
            </header>
          )}

          {/* 主内容舞台 */}
          <main className="flex-1 overflow-hidden relative select-text flex flex-col min-h-0 min-w-0 bg-[#161618]">
            {children}
          </main>
        </div>

        {/* 2.2 Codex 风格右侧侧边栏 */}
        <RightSidebar />
      </div>

      {/* 全局固定右侧边栏切换按钮：fixed 定位，始终在同一屏幕坐标，图标随开关状态切换 */}
      {pathname !== "/login" && !pathname.startsWith("/marketplace") && (
        <button
          type="button"
          onClick={toggleRightSidebar}
          title={isRightSidebarOpen ? "收起侧边栏" : "展开侧边栏"}
          className="fixed top-2 right-2.5 z-[60] w-7 h-7 flex items-center justify-center rounded-md text-[#8E8E93] hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
        >
          {isRightSidebarOpen ? (
            <PanelRightClose className="w-4 h-4" />
          ) : (
            <PanelRight className="w-4 h-4" />
          )}
        </button>
      )}
    </div>
  );
}
