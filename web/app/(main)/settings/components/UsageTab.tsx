"use client";

import React from "react";
import { Gauge, Zap, TrendingUp, DollarSign } from "lucide-react";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useModelConfigStore } from "@/stores/useModelConfigStore";

export function UsageTab() {
  const { profile } = useSettingsStore();
  const { sessions } = useSessionStore();
  const { models } = useModelConfigStore();

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2.5">
          <Gauge className="w-6 h-6 text-amber-400" />
          <span>使用情况与配额</span>
        </h2>
        <p className="text-xs text-[#8E8E93] mt-1.5 leading-relaxed">
          监控会话调用频次、Token 生成开销及本地工作空间的使用额度。
        </p>
      </div>

      {/* 配额进度卡片 */}
      <div className="p-6 rounded-2xl bg-[#18181b]/70 border border-[#27272a] space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <span className="text-xs text-[#8E8E93]">当前周期基础算力使用</span>
            <div className="text-2xl font-bold text-white font-mono">
              {profile.usagePercentage}%
            </div>
          </div>
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            状态健康
          </span>
        </div>

        {/* 进度条 */}
        <div className="w-full h-2 bg-[#222226] rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-500"
            style={{ width: `${profile.usagePercentage}%` }}
          />
        </div>

        <div className="flex items-center justify-between text-[11px] text-[#71717A]">
          <span>已使用计算配额</span>
          <span>配额充足（自定义 API Key 计费由服务商直接结算）</span>
        </div>
      </div>

      {/* 核心指标统计 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-5 rounded-2xl bg-[#18181b]/70 border border-[#27272a] space-y-2">
          <div className="flex items-center gap-2 text-blue-400 text-xs font-semibold">
            <Zap className="w-4 h-4" />
            <span>已配置端点</span>
          </div>
          <div className="text-2xl font-bold text-white font-mono">
            {models.length}
          </div>
          <div className="text-[11px] text-[#71717A]">包含 DeepSeek / 自定义模型</div>
        </div>

        <div className="p-5 rounded-2xl bg-[#18181b]/70 border border-[#27272a] space-y-2">
          <div className="flex items-center gap-2 text-purple-400 text-xs font-semibold">
            <TrendingUp className="w-4 h-4" />
            <span>历史会话总数</span>
          </div>
          <div className="text-2xl font-bold text-white font-mono">
            {sessions.length}
          </div>
          <div className="text-[11px] text-[#71717A]">已同步至数据库</div>
        </div>

        <div className="p-5 rounded-2xl bg-[#18181b]/70 border border-[#27272a] space-y-2">
          <div className="flex items-center gap-2 text-emerald-400 text-xs font-semibold">
            <DollarSign className="w-4 h-4" />
            <span>计费模式</span>
          </div>
          <div className="text-2xl font-bold text-white">BYOK</div>
          <div className="text-[11px] text-[#71717A]">自带密钥，直连官方</div>
        </div>
      </div>
    </div>
  );
}
