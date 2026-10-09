"use client";

import React from "react";
import { Check, Plus } from "lucide-react";
import { PluginItem, useMarketplaceStore } from "@/stores/useMarketplaceStore";
import { SkillIcon } from "./SkillIcon";

interface PluginCardProps {
  plugin: PluginItem;
  onSelect: (plugin: PluginItem) => void;
}

export function PluginCard({ plugin, onSelect }: PluginCardProps) {
  const { installedPluginIds } = useMarketplaceStore();
  const isInstalled = installedPluginIds.includes(plugin.id);

  return (
    <div
      onClick={() => onSelect(plugin)}
      className="px-3.5 py-3 rounded-xl border border-[#26262B] hover:border-[#383842] bg-[#18181B] hover:bg-[#1E1E23] transition-all cursor-pointer flex items-center justify-between group shadow-sm select-none"
    >
      <div className="flex items-center gap-3 min-w-0 flex-1 mr-3">
        {/* 技能 / 插件图标 */}
        <SkillIcon iconType={plugin.iconType} className="w-9 h-9" />

        {/* 标题与描述 */}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-white group-hover:text-white truncate">
            {plugin.name}
          </div>
          <div className="text-xs text-[#8E8E93] group-hover:text-[#A1A1AA] truncate mt-0.5 font-normal">
            {plugin.description}
          </div>
        </div>
      </div>

      {/* 右侧状态：已安装勾选符 ✓ 或 添加按钮 */}
      <div className="shrink-0 flex items-center">
        {isInstalled ? (
          <Check className="w-4 h-4 text-[#71717A] group-hover:text-[#A1A1AA] transition-colors" strokeWidth={2} />
        ) : (
          <div className="p-1 rounded-md text-[#71717A] group-hover:text-white group-hover:bg-white/[0.08] transition-all">
            <Plus className="w-3.5 h-3.5" />
          </div>
        )}
      </div>
    </div>
  );
}
