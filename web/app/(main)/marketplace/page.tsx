"use client";

import React, { useState } from "react";
import {
  RotateCw,
  Settings,
  ChevronDown,
  Search,
  UploadCloud,
  Layers,
} from "lucide-react";
import { useMarketplaceStore, PluginItem } from "@/stores/useMarketplaceStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { PluginCard } from "@/components/marketplace/PluginCard";
import { PluginDetailModal } from "@/components/marketplace/PluginDetailModal";
import { UploadPluginModal } from "@/components/marketplace/UploadPluginModal";

export default function MarketplacePage() {
  const { plugins, installedPluginIds } = useMarketplaceStore();
  const { openSettingsModal } = useSettingsStore();

  const [topTab, setTopTab] = useState<"skills" | "plugins">("skills");
  const [scopeFilter, setScopeFilter] = useState<"personal" | "system">("personal");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPlugin, setSelectedPlugin] = useState<PluginItem | null>(null);
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [showAllInstalled, setShowAllInstalled] = useState(false);

  // 区分技能 vs 插件
  const currentCategoryPlugins = plugins.filter((p) =>
    topTab === "skills" ? p.type === "skill" : p.type === "mcp"
  );

  // 已安装项
  const installedList = currentCategoryPlugins.filter((p) =>
    installedPluginIds.includes(p.id)
  );

  const displayedInstalled = showAllInstalled
    ? installedList
    : installedList.slice(0, 6);

  const remainingInstalledCount = Math.max(
    0,
    installedList.length - displayedInstalled.length
  );

  // 作用域过滤项 (个人 / 系统)
  const scopedList = currentCategoryPlugins.filter((p) => {
    const matchesScope =
      scopeFilter === "personal"
        ? p.scope === "personal"
        : p.scope === "system" || !p.scope;
    const matchesSearch =
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.description.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesScope && matchesSearch;
  });

  return (
    <div className="flex-1 flex flex-col h-full bg-canvas overflow-hidden select-none">
      {/* 1. Codex 风格顶部控制栏 (插件 / 技能 Tab + 刷新 + 设置 + 添加 ▾) */}
      <div className="h-11 px-8 flex items-center justify-between border-b border-hairline/60 flex-shrink-0">
        {/* 左侧：插件 / 技能切换 */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTopTab("plugins")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              topTab === "plugins"
                ? "bg-[#2A2A2E] text-white"
                : "text-[#8E8E93] hover:text-white"
            }`}
          >
            插件
          </button>
          <button
            type="button"
            onClick={() => setTopTab("skills")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              topTab === "skills"
                ? "bg-[#2A2A2E] text-white"
                : "text-[#8E8E93] hover:text-white"
            }`}
          >
            技能
          </button>
        </div>

        {/* 右侧：刷新、设置齿轮、添加下拉按钮 */}
        <div className="flex items-center gap-2 relative">
          <button
            type="button"
            title="刷新列表"
            onClick={() => window.location.reload()}
            className="p-1.5 rounded-md text-[#8E8E93] hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="插件设置"
            onClick={() => openSettingsModal("plugins")}
            className="p-1.5 rounded-md text-[#8E8E93] hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>

          {/* 添加 ▾ 药丸按钮 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsAddMenuOpen(!isAddMenuOpen)}
              className="h-7 px-2.5 rounded-md bg-white hover:bg-neutral-200 text-black text-xs font-medium flex items-center gap-1 transition-colors"
            >
              <span>添加</span>
              <ChevronDown className="w-3 h-3 text-black" />
            </button>

            {/* 下拉选单 */}
            {isAddMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setIsAddMenuOpen(false)}
                />
                <div className="absolute right-0 top-full mt-1.5 w-44 rounded-xl bg-[#1C1C20] border border-[#2B2B31] shadow-2xl py-1 z-40 text-xs text-codex-text animate-in fade-in zoom-in-95 duration-100">
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddMenuOpen(false);
                      setIsUploadOpen(true);
                    }}
                    className="w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-white/[0.06] transition-colors"
                  >
                    <UploadCloud className="w-3.5 h-3.5 text-codex-muted" />
                    <span>从本地导入技能</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddMenuOpen(false);
                      openSettingsModal("plugins");
                    }}
                    className="w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-white/[0.06] transition-colors"
                  >
                    <Layers className="w-3.5 h-3.5 text-codex-muted" />
                    <span>配置 MCP 服务器</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 2. 页面主体内容区 (完全对标 Codex 截图 2) */}
      <div className="flex-1 overflow-y-auto px-8 md:px-12 py-8 max-w-4xl mx-auto w-full scrollbar-thin">
        {/* 大标题与副标题 */}
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">
            {topTab === "skills" ? "技能" : "插件"}
          </h1>
          <p className="text-xs text-[#8E8E93] mt-1.5">
            {topTab === "skills"
              ? "通过任务专用技能扩展 Genesis 的能力"
              : "通过标准协议连接外部开发工具与 MCP 服务器"}
          </p>
        </div>

        {/* 胶囊搜索框 */}
        <div className="relative mt-6">
          <Search className="w-4 h-4 text-[#6E6E73] absolute left-3.5 top-2.5 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={topTab === "skills" ? "搜索技能" : "搜索插件"}
            className="w-full h-9 pl-10 pr-4 rounded-full bg-[#1C1C20] border border-[#2B2B31] focus:border-[#44444C] text-xs text-white placeholder:text-[#6E6E73] outline-none transition-colors"
          />
        </div>

        {/* 已安装区域 */}
        <div className="mt-8">
          <div className="text-sm font-semibold text-white mb-3.5">已安装</div>

          {/* 双列卡片网格 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {displayedInstalled.map((item) => (
              <PluginCard
                key={item.id}
                plugin={item}
                onSelect={(p) => setSelectedPlugin(p)}
              />
            ))}
          </div>

          {/* 展开/收起项 */}
          {remainingInstalledCount > 0 && !showAllInstalled && (
            <button
              type="button"
              onClick={() => setShowAllInstalled(true)}
              className="text-xs text-[#8E8E93] hover:text-white mt-3.5 block transition-colors cursor-pointer"
            >
              查看更多技能，另有 {remainingInstalledCount} 项
            </button>
          )}
        </div>

        {/* 作用域分类小药丸 (个人 / 系统) */}
        <div className="flex items-center gap-1.5 mt-8 mb-3.5">
          <button
            type="button"
            onClick={() => setScopeFilter("personal")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              scopeFilter === "personal"
                ? "bg-[#2A2A2E] text-white"
                : "text-[#8E8E93] hover:text-white"
            }`}
          >
            个人
          </button>
          <button
            type="button"
            onClick={() => setScopeFilter("system")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              scopeFilter === "system"
                ? "bg-[#2A2A2E] text-white"
                : "text-[#8E8E93] hover:text-white"
            }`}
          >
            系统
          </button>
        </div>

        {/* 分类过滤下的双列网格 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {scopedList.map((item) => (
            <PluginCard
              key={item.id}
              plugin={item}
              onSelect={(p) => setSelectedPlugin(p)}
            />
          ))}
        </div>
      </div>

      {/* 详情与安装弹窗 */}
      <PluginDetailModal
        plugin={selectedPlugin}
        onClose={() => setSelectedPlugin(null)}
      />

      {/* 上传自定义技能模态窗 */}
      <UploadPluginModal
        isOpen={isUploadOpen}
        onClose={() => setIsUploadOpen(false)}
      />
    </div>
  );
}
