"use client";

import React from "react";
import { BookOpen, Type, Check, LayoutGrid, Rows } from "lucide-react";
import { useSettingsStore } from "@/stores/useSettingsStore";

export function AppearancePanel() {
  const { serifReading, setSerifReading, density, setDensity } =
    useSettingsStore();

  return (
    <div className="space-y-6 text-codex-text select-none">
      {/* 1. 正文排版系统 */}
      <div className="p-5 rounded-xl border border-hairline bg-[#1A1A1E] space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-codex-muted" />
            <span>AI 生成正文排版</span>
          </h3>
          <p className="text-xs text-codex-muted mt-1">
            切换 AI 回复的字体排印体系。衬线体提供技术白皮书的深沉专注感，无衬线体适合紧凑代码检索。
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* 选项 A: 衬线体 */}
          <div
            onClick={() => setSerifReading(true)}
            className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
              serifReading
                ? "bg-white/[0.08] border-white/30 shadow-sm"
                : "bg-[#141417] border-hairline hover:border-white/20 hover:bg-white/[0.03]"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-white flex items-center gap-1.5">
                <Type className="w-3.5 h-3.5 text-codex-muted" />
                <span>纸质衬线体 (Newsreader)</span>
              </span>
              {serifReading && (
                <div className="w-4 h-4 rounded-full bg-white text-black flex items-center justify-center">
                  <Check className="w-2.5 h-2.5 stroke-[3]" />
                </div>
              )}
            </div>
            <p className="mt-2 text-xs font-serif leading-relaxed text-codex-muted">
              在 Genesis 架构中，协程非阻塞沙箱保障高并发响应。
            </p>
          </div>

          {/* 选项 B: 现代无衬线 */}
          <div
            onClick={() => setSerifReading(false)}
            className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
              !serifReading
                ? "bg-white/[0.08] border-white/30 shadow-sm"
                : "bg-[#141417] border-hairline hover:border-white/20 hover:bg-white/[0.03]"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-white flex items-center gap-1.5">
                <Type className="w-3.5 h-3.5 text-codex-muted" />
                <span>现代无衬线 (Plus Jakarta Sans)</span>
              </span>
              {!serifReading && (
                <div className="w-4 h-4 rounded-full bg-white text-black flex items-center justify-center">
                  <Check className="w-2.5 h-2.5 stroke-[3]" />
                </div>
              )}
            </div>
            <p className="mt-2 text-xs font-sans leading-relaxed text-codex-muted">
              在 Genesis 架构中，协程非阻塞沙箱保障高并发响应。
            </p>
          </div>
        </div>
      </div>

      {/* 2. 动态密度系统 */}
      <div className="p-5 rounded-xl border border-hairline bg-[#1A1A1E] space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <LayoutGrid className="w-4 h-4 text-codex-muted" />
            <span>动态空间密度</span>
          </h3>
          <p className="text-xs text-codex-muted mt-1">
            调节全局消息间隔与内边距阶梯。
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div
            onClick={() => setDensity("comfortable")}
            className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
              density === "comfortable"
                ? "bg-white/[0.08] border-white/30 shadow-sm"
                : "bg-[#141417] border-hairline hover:border-white/20 hover:bg-white/[0.03]"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-white flex items-center gap-1.5">
                <Rows className="w-3.5 h-3.5 text-codex-muted" />
                <span>舒适档 (Comfortable - 24px 间距)</span>
              </span>
              {density === "comfortable" && (
                <div className="w-4 h-4 rounded-full bg-white text-black flex items-center justify-center">
                  <Check className="w-2.5 h-2.5 stroke-[3]" />
                </div>
              )}
            </div>
            <p className="text-[11px] text-codex-muted mt-1.5 leading-snug">
              呼吸感强，适合长时间深入阅读方案与架构设计。
            </p>
          </div>

          <div
            onClick={() => setDensity("compact")}
            className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
              density === "compact"
                ? "bg-white/[0.08] border-white/30 shadow-sm"
                : "bg-[#141417] border-hairline hover:border-white/20 hover:bg-white/[0.03]"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-white flex items-center gap-1.5">
                <Rows className="w-3.5 h-3.5 text-codex-muted" />
                <span>紧凑档 (Compact - 12px 间距)</span>
              </span>
              {density === "compact" && (
                <div className="w-4 h-4 rounded-full bg-white text-black flex items-center justify-center">
                  <Check className="w-2.5 h-2.5 stroke-[3]" />
                </div>
              )}
            </div>
            <p className="text-[11px] text-codex-muted mt-1.5 leading-snug">
              高密度排布，适合高频联调与多文件对比。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
