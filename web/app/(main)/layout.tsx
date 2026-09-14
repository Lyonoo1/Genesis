"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Terminal, Plus, Settings, ShoppingBag, Sliders } from "lucide-react";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { checkBackendHealth } from "@/lib/api/system";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { density, setDensity } = useSettingsStore();
  const [apiStatus, setApiStatus] = useState<"checking" | "online" | "offline">("checking");

  useEffect(() => {
    checkBackendHealth()
      .then(() => setApiStatus("online"))
      .catch(() => setApiStatus("offline"));
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-void text-genesis-primary select-none">
      {/* 1. 左侧固定 240px 侧边栏外壳 */}
      <aside className="w-[240px] flex-shrink-0 flex flex-col bg-sidebar border-r border-hairline select-none">
        {/* Brand Header */}
        <div className="h-12 px-4 flex items-center justify-between border-b border-hairline">
          <div className="flex items-center gap-2">
            <div className="w-[18px] h-[18px] rounded bg-accent-cyan/10 border border-accent-cyan/30 flex items-center justify-center drop-shadow-[0_0_6px_rgba(34,211,238,0.4)]">
              <Terminal className="w-3 h-3 text-accent-cyan" />
            </div>
            <span className="font-mono text-xs font-medium tracking-widest text-genesis-primary uppercase">
              Genesis
            </span>
          </div>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-hairline text-genesis-muted">
            v0.1
          </span>
        </div>

        {/* 新建会话占位 */}
        <div className="p-3">
          <button className="w-full h-8 px-2.5 rounded-md border border-hairline bg-surface-sidebar hover:border-hairline-hover hover:bg-white/[0.04] transition-all flex items-center justify-between text-xs text-genesis-secondary">
            <div className="flex items-center gap-2">
              <Plus className="w-3.5 h-3.5 text-accent-cyan" />
              <span>新建对话</span>
            </div>
            <kbd className="text-[10px] font-mono text-genesis-muted">⌘J</kbd>
          </button>
        </div>

        {/* 会话列表槽位 */}
        <div className="flex-1 overflow-y-auto px-2 space-y-1">
          <div className="px-2 py-1.5 text-[11px] font-medium text-genesis-muted uppercase tracking-wider">
            今天
          </div>
          <div className="px-2.5 py-1.5 rounded-md text-xs text-genesis-primary bg-white/[0.08] border-l-2 border-accent-cyan flex items-center justify-between cursor-pointer">
            <span className="truncate">项目架构总览与规划</span>
          </div>
        </div>

        {/* 底部导航槽 */}
        <div className="p-2 border-t border-hairline space-y-1">
          <Link
            href="/marketplace"
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-genesis-secondary hover:text-genesis-primary hover:bg-white/[0.04] transition-colors"
          >
            <ShoppingBag className="w-3.5 h-3.5" />
            <span>应用市场</span>
          </Link>
          <Link
            href="/settings"
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-genesis-secondary hover:text-genesis-primary hover:bg-white/[0.04] transition-colors"
          >
            <Settings className="w-3.5 h-3.5" />
            <span>偏好设置</span>
          </Link>
        </div>
      </aside>

      {/* 2. 主区域 */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* 顶部控制条外壳 (TopNavShell - 48px) */}
        <header className="h-12 flex-shrink-0 bg-void/75 backdrop-blur-md border-b border-hairline px-6 flex items-center justify-between z-10">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-sm font-medium text-genesis-primary truncate">
              项目架构总览与规划
            </h1>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-accent-cyan/10 border border-accent-cyan/30 text-accent-cyan">
              Agent Ready
            </span>
            {apiStatus === "online" && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono bg-accent-emerald/10 border border-accent-emerald/30 text-accent-emerald">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-emerald animate-pulse" />
                API 在线 (Port 8000)
              </span>
            )}
            {apiStatus === "offline" && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono bg-accent-coral/10 border border-accent-coral/30 text-accent-coral">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-coral" />
                API 离线 (请检查 8000 端口)
              </span>
            )}
            {apiStatus === "checking" && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-genesis-muted/10 border border-hairline text-genesis-muted">
                检测后端中...
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* 密度切换按钮 */}
            <button
              onClick={() =>
                setDensity(density === "comfortable" ? "compact" : "comfortable")
              }
              title={`当前密度: ${density === "comfortable" ? "舒适" : "紧凑"}`}
              className="h-7 px-2 rounded border border-hairline hover:border-hairline-hover text-[11px] font-mono flex items-center gap-1 text-genesis-secondary hover:text-genesis-primary transition-colors"
            >
              <Sliders className="w-3 h-3" />
              <span className="capitalize">{density}</span>
            </button>
          </div>
        </header>

        {/* 3. 主内容舞台 (MainStage - 768px 版心) */}
        <main className="flex-1 overflow-y-auto select-text">
          <div className="max-w-3xl mx-auto h-full px-4 py-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
