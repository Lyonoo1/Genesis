"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  Gauge,
  Sparkles,
  Settings,
  LogOut,
  ChevronRight,
  Globe,
  Smile,
  Database,
  ExternalLink,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useChatStore } from "@/stores/useChatStore";
import { supabase } from "@/lib/supabase/client";

export function ProfileFooter() {
  const router = useRouter();
  const { profile, updateProfileSettings } = useSettingsStore();
  const safeProfile = profile || {
    name: "李昂",
    avatarText: "LY",
    usagePercentage: 12,
    email: "lyon@example.com",
  };
  const [isOpen, setIsOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // 初始化拉取当前登录用户
  useEffect(() => {
    supabase.auth
      .getUser()
      .then(({ data: { user } }) => {
        if (user?.email) {
          updateProfileSettings({
            email: user.email,
            name: user.user_metadata?.name || user.email.split("@")[0],
            avatarText: (user.user_metadata?.name || user.email.slice(0, 2)).toUpperCase(),
          });
        }
      })
      .catch(() => {});
  }, [updateProfileSettings]);

  const handleLogout = async () => {
    setIsOpen(false);

    // 1. 跨 Tab 同步广播登出事件 (BroadcastChannel + storage event 双保险)
    try {
      if (typeof window !== "undefined" && window.BroadcastChannel) {
        const bc = new BroadcastChannel("genesis_auth_channel");
        bc.postMessage({ type: "LOGOUT" });
        bc.close();
      }
    } catch {}

    try {
      localStorage.setItem("genesis_logout_timestamp", Date.now().toString());
    } catch {}

    // 2. 清除 Supabase 云端会话
    try {
      await supabase.auth.signOut();
    } catch {
      // ignore network errors on signout
    }

    // 3. 彻底清空内存与本地缓存
    useSessionStore.getState().resetSessionStore();
    useChatStore.getState().resetChatStore();

    localStorage.removeItem("genesis_auth_token");
    localStorage.removeItem("genesis_logout_timestamp");

    // 4. 彻底销毁 Cookie (max-age=0 强制立即失效)
    document.cookie =
      "genesis_auth_token=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax";

    window.location.href = "/login";
  };

  // 点击外部关闭 Popover
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleOpenSettings = (tab = "general") => {
    setIsOpen(false);
    router.push(`/settings?tab=${tab}`);
  };

  return (
    <div className="relative px-2.5 py-2 select-none flex-shrink-0 border-t border-[#38383A]" ref={popoverRef}>
      {/* 向上弹出的个人菜单 Popover */}
      {isOpen && (
        <div className="absolute bottom-14 left-2.5 right-2.5 z-50 py-1.5 bg-[#1B1B1F] border border-[#2C2C33] rounded-xl shadow-2xl text-xs space-y-1 animate-in fade-in zoom-in-95">
          {/* 用户基础信息 */}
          <div className="px-3 py-2">
            <div className="font-medium text-white truncate text-sm">
              {safeProfile.name}
            </div>
            {safeProfile.email && (
              <div className="text-[11px] text-codex-muted truncate">
                {safeProfile.email}
              </div>
            )}
          </div>

          <div className="h-[1px] bg-hairline mx-2" />

          {/* 菜单项 1: 剩余用量 */}
          <button
            type="button"
            onClick={() => handleOpenSettings("usage")}
            className="w-full px-3 py-2 flex items-center justify-between text-codex-text hover:bg-white/[0.06] transition-colors text-left"
          >
            <div className="flex items-center gap-2.5">
              <Gauge className="w-4 h-4 text-codex-muted" />
              <span>剩余用量</span>
            </div>
            <ChevronRight className="w-3.5 h-3.5 text-codex-subtle" />
          </button>

          {/* 菜单项 2: 隐藏宠物 */}
          <button
            type="button"
            className="w-full px-3 py-2 flex items-center gap-2.5 text-codex-text hover:bg-white/[0.06] transition-colors text-left"
          >
            <Smile className="w-4 h-4 text-codex-muted" />
            <span>隐藏宠物</span>
          </button>

          {/* 菜单项 3: 升级以获享更高限额 */}
          <button
            type="button"
            className="w-full px-3 py-2 flex items-center justify-between text-codex-text hover:bg-white/[0.06] transition-colors text-left"
          >
            <div className="flex items-center gap-2.5">
              <Sparkles className="w-4 h-4 text-accent-blue" />
              <span>升级以获享更高限额</span>
            </div>
            <Globe className="w-3.5 h-3.5 text-codex-subtle" />
          </button>

          {/* 菜单项 4: 设置 */}
          <button
            type="button"
            onClick={() => handleOpenSettings("general")}
            className="w-full px-3 py-2 flex items-center justify-between text-codex-text hover:bg-white/[0.06] transition-colors text-left"
          >
            <div className="flex items-center gap-2.5">
              <Settings className="w-4 h-4 text-codex-muted" />
              <span>设置</span>
            </div>
            <span className="font-mono text-[11px] text-codex-subtle px-1 py-0.5 rounded bg-white/[0.04] border border-hairline/60">
              ⌘,
            </span>
          </button>

          {/* 菜单项 5: 数据库可视化看板 */}
          <a
            href="/db"
            target="_blank"
            rel="noreferrer"
            className="w-full px-3 py-2 flex items-center justify-between text-codex-text hover:bg-white/[0.06] transition-colors text-left"
          >
            <div className="flex items-center gap-2.5">
              <Database className="w-4 h-4 text-emerald-400" />
              <span>数据库可视化看板</span>
            </div>
            <ExternalLink className="w-3.5 h-3.5 text-codex-subtle" />
          </a>

          <div className="h-[1px] bg-hairline mx-2" />

          {/* 菜单项 5: 退出登录 */}
          <button
            type="button"
            onClick={handleLogout}
            className="w-full px-3 py-2 flex items-center gap-2.5 text-accent-coral hover:bg-accent-coral/10 transition-colors text-left cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
            <span>退出登录</span>
          </button>
        </div>
      )}

      {/* 底部常驻用户信息胶囊 Pill */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-white/[0.06] transition-all cursor-pointer group"
      >
        <span className="text-xs font-medium text-codex-text truncate">
          {safeProfile.name}
        </span>
      </button>
    </div>
  );
}
