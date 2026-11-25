"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  Gauge,
  Settings,
  LogOut,
  ChevronRight,
  ChevronUp,
  Database,
  ExternalLink,
  Cpu,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useChatStore } from "@/stores/useChatStore";
import { getApiBaseUrl, getAuthToken, getBasePath } from "@/lib/api/client";
import { supabase } from "@/lib/supabase/client";

const IS_DEV = process.env.NODE_ENV === "development";

export function ProfileFooter() {
  const router = useRouter();
  const { profile, updateProfileSettings } = useSettingsStore();
  const safeProfile = profile || {
    name: "本地用户",
    avatarText: "ME",
    usagePercentage: 0,
    email: "",
  };
  const [isOpen, setIsOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const token = getAuthToken();
    if (token) {
      fetch(`${getApiBaseUrl()}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.email) {
            const displayName = data.name || data.email.split("@")[0];
            updateProfileSettings({
              email: data.email,
              name: displayName,
              avatarText: displayName.slice(0, 2).toUpperCase(),
            });
          }
        })
        .catch(() => {});
    } else {
      supabase.auth
        .getUser()
        .then(({ data: { user } }) => {
          if (user?.email) {
            const displayName =
              user.user_metadata?.name || user.email.split("@")[0];
            updateProfileSettings({
              email: user.email,
              name: displayName,
              avatarText: displayName.slice(0, 2).toUpperCase(),
            });
          }
        })
        .catch(() => {});
    }
  }, [updateProfileSettings]);

  const handleLogout = async () => {
    setIsOpen(false);

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

    try {
      await supabase.auth.signOut();
    } catch {}

    useSessionStore.getState().resetSessionStore();
    useChatStore.getState().resetChatStore();

    localStorage.removeItem("genesis_auth_token");
    localStorage.removeItem("genesis_logout_timestamp");

    document.cookie =
      "genesis_auth_token=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax";

    window.location.href = `${getBasePath()}/login`;
  };

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

  const displayName =
    safeProfile.name === "developer" ? "本地工作区" : safeProfile.name || "本地用户";
  const avatarInitials = (safeProfile.avatarText || displayName.slice(0, 2)).slice(0, 2).toUpperCase();

  return (
    <div
      className="relative px-2.5 py-2 select-none flex-shrink-0 border-t border-[#38383A]"
      ref={popoverRef}
    >
      {/* 向上弹出的个人菜单 Popover */}
      {isOpen && (
        <div className="absolute bottom-14 left-2.5 right-2.5 z-50 py-1.5 bg-[#1B1B1F] border border-[#2C2C33] rounded-xl shadow-2xl text-xs space-y-1 animate-in fade-in zoom-in-95">
          {/* 用户基础信息 */}
          <div className="px-3 py-2 flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500/30 to-indigo-500/30 border border-white/15 flex items-center justify-center text-[11px] font-semibold text-white shrink-0">
              {avatarInitials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-white truncate text-xs">
                {displayName}
              </div>
              {safeProfile.email && (
                <div className="text-[11px] text-codex-muted truncate">
                  {safeProfile.email}
                </div>
              )}
            </div>
          </div>

          <div className="h-[1px] bg-hairline mx-2" />

          {/* 菜单项 1: 模型与 API Key 配置 */}
          <button
            type="button"
            onClick={() => handleOpenSettings("models")}
            className="w-full px-3 py-2 flex items-center justify-between text-codex-text hover:bg-white/[0.06] transition-colors text-left cursor-pointer"
          >
            <div className="flex items-center gap-2.5">
              <Cpu className="w-4 h-4 text-blue-400" />
              <span>模型与 API Key</span>
            </div>
            <ChevronRight className="w-3.5 h-3.5 text-codex-subtle" />
          </button>

          {/* 菜单项 2: 用量统计 */}
          <button
            type="button"
            onClick={() => handleOpenSettings("usage")}
            className="w-full px-3 py-2 flex items-center justify-between text-codex-text hover:bg-white/[0.06] transition-colors text-left cursor-pointer"
          >
            <div className="flex items-center gap-2.5">
              <Gauge className="w-4 h-4 text-codex-muted" />
              <span>用量统计</span>
            </div>
            <ChevronRight className="w-3.5 h-3.5 text-codex-subtle" />
          </button>

          {/* 菜单项 3: 系统设置 */}
          <button
            type="button"
            onClick={() => handleOpenSettings("general")}
            className="w-full px-3 py-2 flex items-center justify-between text-codex-text hover:bg-white/[0.06] transition-colors text-left cursor-pointer"
          >
            <div className="flex items-center gap-2.5">
              <Settings className="w-4 h-4 text-codex-muted" />
              <span>系统设置</span>
            </div>
            <span className="font-mono text-[11px] text-codex-subtle px-1 py-0.5 rounded bg-white/[0.04] border border-hairline/60">
              ⌘,
            </span>
          </button>

          {/* 仅开发态可见的数据库调试看板（生产与面客桌面端彻底隐藏） */}
          {IS_DEV && (
            <a
              href={`${getBasePath()}/db`}
              target="_blank"
              rel="noreferrer"
              className="w-full px-3 py-2 flex items-center justify-between text-codex-text hover:bg-white/[0.06] transition-colors text-left"
            >
              <div className="flex items-center gap-2.5">
                <Database className="w-4 h-4 text-emerald-400" />
                <span>数据库看板 (Dev)</span>
              </div>
              <ExternalLink className="w-3.5 h-3.5 text-codex-subtle" />
            </a>
          )}

          <div className="h-[1px] bg-hairline mx-2" />

          {/* 菜单项: 退出登录 */}
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

      {/* 底部常驻用户信息胶囊 Pill（带头像、快捷设置按钮与展开箭头） */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex-1 min-w-0 flex items-center justify-between px-2 py-1.5 rounded-xl hover:bg-white/[0.06] transition-all cursor-pointer group"
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500/30 to-indigo-500/30 border border-white/15 flex items-center justify-center text-[10px] font-semibold text-white shrink-0">
              {avatarInitials}
            </div>
            <span className="text-xs font-medium text-codex-text truncate">
              {displayName}
            </span>
          </div>
          <ChevronUp
            className={`w-3.5 h-3.5 text-zinc-500 group-hover:text-zinc-300 transition-transform duration-150 shrink-0 ${
              isOpen ? "rotate-180 text-white" : ""
            }`}
          />
        </button>

        <button
          type="button"
          onClick={() => handleOpenSettings("models")}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer shrink-0"
          title="模型与系统设置 (⌘,)"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
