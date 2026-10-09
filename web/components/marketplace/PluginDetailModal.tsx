"use client";

import React, { useState } from "react";
import { X, Loader2, Download, Trash2, Check } from "lucide-react";
import { PluginItem, useMarketplaceStore } from "@/stores/useMarketplaceStore";
import { SkillIcon } from "./SkillIcon";
import { PermissionShield } from "./PermissionShield";

interface PluginDetailModalProps {
  plugin: PluginItem | null;
  onClose: () => void;
}

export function PluginDetailModal({ plugin, onClose }: PluginDetailModalProps) {
  const { installedPluginIds, installPlugin, uninstallPlugin } =
    useMarketplaceStore();
  const [loading, setLoading] = useState(false);

  if (!plugin) return null;

  const isInstalled = installedPluginIds.includes(plugin.id);

  const handleAction = async () => {
    setLoading(true);
    if (isInstalled) {
      await uninstallPlugin(plugin.id);
    } else {
      await installPlugin(plugin.id);
    }
    setLoading(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-[#18181C] border border-[#2B2B31] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-150 select-none text-codex-text"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部信息 */}
        <div className="p-5 border-b border-hairline flex items-start justify-between bg-white/[0.02]">
          <div className="flex items-start gap-3.5">
            <SkillIcon iconType={plugin.iconType} className="w-11 h-11" />
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-white">
                  {plugin.name}
                </h3>
                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded border border-[#2B2B31] text-codex-muted">
                  v{plugin.version}
                </span>
              </div>
              <p className="text-xs text-codex-muted mt-1">
                由 {plugin.author} 提供 · {plugin.downloads} 次使用
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-codex-muted hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 滚动内容区 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 select-text scrollbar-thin">
          {/* 简要描述 */}
          <p className="text-sm text-[#ECECEE] leading-relaxed">
            {plugin.description}
          </p>

          {/* 权限安全盾牌卡片 */}
          <PermissionShield permissions={plugin.permissions} />

          {/* Readme 详情 */}
          <div className="space-y-2 pt-2 border-t border-hairline">
            <h4 className="text-xs font-mono font-medium text-codex-muted uppercase tracking-wider">
              能力说明
            </h4>
            <div className="p-3.5 rounded-xl bg-[#141417] border border-hairline font-mono text-xs text-codex-muted leading-relaxed whitespace-pre-wrap">
              {plugin.readme}
            </div>
          </div>
        </div>

        {/* 底部操作条 */}
        <div className="p-4 border-t border-hairline bg-white/[0.02] flex items-center justify-between select-none">
          <div className="text-xs text-codex-muted flex items-center gap-1.5">
            <span>状态:</span>
            {isInstalled ? (
              <span className="text-white font-medium flex items-center gap-1">
                <Check className="w-3.5 h-3.5 text-blue-400" />
                已安装就绪
              </span>
            ) : (
              <span>未安装</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs text-codex-muted hover:text-white hover:bg-white/[0.06] transition-colors"
            >
              关闭
            </button>

            {isInstalled ? (
              <button
                onClick={handleAction}
                disabled={loading}
                className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 flex items-center gap-1.5 transition-all disabled:opacity-50"
              >
                {loading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                <span>卸载</span>
              </button>
            ) : (
              <button
                onClick={handleAction}
                disabled={loading}
                className="px-4 py-1.5 rounded-lg text-xs font-medium bg-white hover:bg-neutral-200 text-black flex items-center gap-1.5 transition-all disabled:opacity-50"
              >
                {loading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-black" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                <span>立即安装</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
