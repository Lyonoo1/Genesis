"use client";

import React, { useState, useEffect, Suspense, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Search,
  Settings,
  Cpu,
  History,
  Palette,
  User,
  Keyboard,
  Gauge,
  Database,
  Puzzle,
  ChevronLeft,
  ChevronRight,
  Sidebar as SidebarIcon,
} from "lucide-react";
import { useSettingsStore, SettingsTab } from "@/stores/useSettingsStore";
import { GeneralTab } from "./components/GeneralTab";
import { ModelsTab } from "./components/ModelsTab";
import { HistoryTab } from "./components/HistoryTab";
import { AppearanceTab } from "./components/AppearanceTab";
import { ShortcutsTab } from "./components/ShortcutsTab";
import { UsageTab } from "./components/UsageTab";
import { DatabaseTab } from "./components/DatabaseTab";
import { ProfileTab } from "./components/ProfileTab";
import { PluginsTab } from "./components/PluginsTab";

interface NavItem {
  id: SettingsTab;
  name: string;
  icon: React.ElementType;
  section: "personal" | "integration";
}

const NAV_ITEMS: NavItem[] = [
  // 个人分组
  { id: "general", name: "常规", icon: Settings, section: "personal" },
  { id: "models", name: "模型配置", icon: Cpu, section: "personal" },
  { id: "history", name: "历史与已归档", icon: History, section: "personal" },
  { id: "appearance", name: "外观", icon: Palette, section: "personal" },
  { id: "profile", name: "个人资料", icon: User, section: "personal" },
  { id: "shortcuts", name: "键盘快捷键", icon: Keyboard, section: "personal" },
  { id: "usage", name: "使用情况和计费", icon: Gauge, section: "personal" },
  { id: "database", name: "数据库看板", icon: Database, section: "personal" },

  // 集成分组
  { id: "plugins", name: "插件", icon: Puzzle, section: "integration" },
];

function SettingsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabFromQuery = (searchParams.get("tab") as SettingsTab) || "general";

  const { activeSettingsTab, setActiveSettingsTab } = useSettingsStore();
  const [searchFilter, setSearchFilter] = useState("");

  // 同步 URL 参数和 store
  useEffect(() => {
    if (tabFromQuery && tabFromQuery !== activeSettingsTab) {
      setActiveSettingsTab(tabFromQuery);
    }
  }, [tabFromQuery, activeSettingsTab, setActiveSettingsTab]);

  // 快捷键监听：Esc 或 ⌘, 返回主工作台
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        router.push("/chat");
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [router]);

  const handleSelectTab = (tabId: SettingsTab) => {
    setActiveSettingsTab(tabId);
    router.replace(`/settings?tab=${tabId}`, { scroll: false });
  };

  const handleBackToApp = () => {
    router.push("/chat");
  };

  // 过滤导航项
  const filteredNavItems = useMemo(() => {
    if (!searchFilter.trim()) return NAV_ITEMS;
    return NAV_ITEMS.filter((item) =>
      item.name.toLowerCase().includes(searchFilter.toLowerCase())
    );
  }, [searchFilter]);

  const personalItems = filteredNavItems.filter((i) => i.section === "personal");
  const integrationItems = filteredNavItems.filter(
    (i) => i.section === "integration"
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#141416] text-[#D4D4D8] select-none font-sans antialiased">
      {/* 1. 左侧设置侧边栏 (260px，对齐 Codex 设计) */}
      <aside className="w-[260px] bg-[#18181b] border-r border-[#26262B] flex flex-col shrink-0">
        {/* 控制栏 */}
        <div className="pt-3.5 px-4 pb-2 flex items-center justify-end shrink-0">
          <div className="flex items-center gap-1 text-[#71717A]">
            <button
              type="button"
              onClick={handleBackToApp}
              className="p-1 rounded-md hover:text-white hover:bg-white/[0.06] transition-colors"
              title="返回应用"
            >
              <SidebarIcon className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleBackToApp}
              className="p-1 rounded-md hover:text-white hover:bg-white/[0.06] transition-colors"
              title="返回"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              className="p-1 rounded-md text-[#52525B] cursor-not-allowed"
              disabled
              title="前进"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 关键返回按钮：← 返回应用 */}
        <div className="px-3 pt-1 pb-2">
          <button
            type="button"
            onClick={handleBackToApp}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium text-white hover:bg-white/[0.08] transition-colors group cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4 text-[#8E8E93] group-hover:text-white group-hover:-translate-x-0.5 transition-transform" />
            <span>返回应用</span>
          </button>
        </div>

        {/* 搜索框 */}
        <div className="px-3 pb-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="搜索设置..."
              className="w-full h-8 pl-8 pr-3 rounded-xl bg-[#141416] border border-[#27272a] text-xs text-white placeholder-[#71717A] focus:outline-none focus:border-[#4B4B55] transition-colors"
            />
          </div>
        </div>

        {/* 导航菜单区 */}
        <div className="flex-1 overflow-y-auto px-2 space-y-4 pb-4">
          {/* 个人分组 */}
          {personalItems.length > 0 && (
            <div className="space-y-0.5">
              <div className="px-3 py-1 text-[11px] font-semibold text-[#71717A] tracking-wider">
                个人
              </div>
              {personalItems.map((item) => {
                const isActive = activeSettingsTab === item.id;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectTab(item.id)}
                    className={`w-full h-8 px-3 rounded-xl text-xs flex items-center gap-2.5 transition-colors cursor-pointer text-left ${
                      isActive
                        ? "bg-[#27272a] text-white font-medium"
                        : "text-[#A1A1AA] hover:text-white hover:bg-white/[0.04]"
                    }`}
                  >
                    <Icon
                      className={`w-4 h-4 shrink-0 ${
                        isActive ? "text-white" : "text-[#71717A]"
                      }`}
                    />
                    <span className="truncate">{item.name}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* 集成分组 */}
          {integrationItems.length > 0 && (
            <div className="space-y-0.5">
              <div className="px-3 py-1 text-[11px] font-semibold text-[#71717A] tracking-wider">
                集成
              </div>
              {integrationItems.map((item) => {
                const isActive = activeSettingsTab === item.id;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectTab(item.id)}
                    className={`w-full h-8 px-3 rounded-xl text-xs flex items-center gap-2.5 transition-colors cursor-pointer text-left ${
                      isActive
                        ? "bg-[#27272a] text-white font-medium"
                        : "text-[#A1A1AA] hover:text-white hover:bg-white/[0.04]"
                    }`}
                  >
                    <Icon
                      className={`w-4 h-4 shrink-0 ${
                        isActive ? "text-white" : "text-[#71717A]"
                      }`}
                    />
                    <span className="truncate">{item.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {/* 2. 右侧主内容舞台 */}
      <main className="flex-1 h-full overflow-y-auto bg-[#141416] p-8 lg:p-12 select-text">
        {activeSettingsTab === "general" && <GeneralTab />}
        {activeSettingsTab === "models" && <ModelsTab />}
        {activeSettingsTab === "history" && <HistoryTab />}
        {activeSettingsTab === "appearance" && <AppearanceTab />}
        {activeSettingsTab === "shortcuts" && <ShortcutsTab />}
        {activeSettingsTab === "usage" && <UsageTab />}
        {activeSettingsTab === "database" && <DatabaseTab />}
        {activeSettingsTab === "profile" && <ProfileTab />}
        {activeSettingsTab === "plugins" && <PluginsTab />}
      </main>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="h-screen w-screen bg-[#141416]" />}>
      <SettingsContent />
    </Suspense>
  );
}
