"use client";

import React, { useState } from "react";
import {
  Database,
  ExternalLink,
  CheckCircle2,
  HardDrive,
  RefreshCw,
  Maximize2,
  ShieldAlert,
} from "lucide-react";

export function DatabaseTab() {
  const [embedStudio, setEmbedStudio] = useState(false);

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2.5">
          <Database className="w-6 h-6 text-emerald-400" />
          <span>数据库看板与同步</span>
        </h2>
        <p className="text-xs text-[#8E8E93] mt-1.5 leading-relaxed">
          Genesis 采用本地 SQLite (`genesis.db`) 与 Supabase Studio 双写架构，保证离线即时响应与多端云端同步。
        </p>
      </div>

      {/* 数据库服务卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Supabase Studio */}
        <div className="p-5 rounded-2xl bg-[#18181b]/70 border border-[#27272a] space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-sm font-semibold text-white">
                Supabase Studio 可视化
              </span>
            </div>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              运行中 (54323)
            </span>
          </div>

          <p className="text-xs text-[#8E8E93] leading-relaxed">
            内置 Postgres 图形化管理平台，可实时查看与编辑 sessions、messages、projects 数据表。
          </p>

          <div className="pt-2 flex items-center gap-2">
            <a
              href="http://127.0.0.1:54323"
              target="_blank"
              rel="noopener noreferrer"
              className="h-8 px-3 rounded-xl text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <span>新标签打开 Studio</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>

            <button
              type="button"
              onClick={() => setEmbedStudio(!embedStudio)}
              className="h-8 px-3 rounded-xl text-xs font-medium bg-white/[0.06] hover:bg-white/[0.1] text-white border border-[#2E2E36] flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span>{embedStudio ? "隐藏内置窗口" : "内置预览"}</span>
            </button>
          </div>
        </div>

        {/* SQLite 本地库 */}
        <div className="p-5 rounded-2xl bg-[#18181b]/70 border border-[#27272a] space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-blue-400" />
              <span className="text-sm font-semibold text-white">
                本地 SQLite 引擎
              </span>
            </div>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-blue-500/10 text-blue-400 border border-blue-500/20">
              genesis.db
            </span>
          </div>

          <p className="text-xs text-[#8E8E93] leading-relaxed">
            本地持久化极速缓存，在断网时保持毫秒级会话读取与消息缓存，与 FastAPI 后端同步畅通。
          </p>

          <div className="pt-2 flex items-center gap-2 text-xs text-[#8E8E93]">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>双写机制已就绪，数据持久化正常</span>
          </div>
        </div>
      </div>

      {/* 内置嵌入预览 */}
      {embedStudio && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-[#8E8E93]">
            <span>Supabase Studio 内嵌视图 (http://127.0.0.1:54323)</span>
            <button
              type="button"
              onClick={() => setEmbedStudio(false)}
              className="hover:text-white"
            >
              关闭视图
            </button>
          </div>
          <div className="w-full h-[600px] rounded-2xl overflow-hidden border border-[#27272a] bg-[#141416]">
            <iframe
              src="http://127.0.0.1:54323"
              className="w-full h-full border-0"
              title="Supabase Studio"
            />
          </div>
        </div>
      )}

      {/* 数据安全与清空指引 */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-[#8E8E93] tracking-wide">
          数据运维
        </h3>
        <div className="p-5 bg-[#18181b]/70 border border-[#27272a] rounded-2xl space-y-3">
          <div className="flex items-center gap-2 text-amber-400 text-xs font-semibold">
            <ShieldAlert className="w-4 h-4" />
            <span>彻底重置与清空数据库</span>
          </div>
          <p className="text-xs text-[#8E8E93] leading-relaxed">
            如需重置所有数据表（清空 sessions、messages、projects），可前往“历史会话与已归档”点击清空，或直接在 Supabase Studio 的 Table Editor 中 Truncate 相关表。
          </p>
        </div>
      </div>
    </div>
  );
}
