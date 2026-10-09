"use client";

import React from "react";
import { Palette, Check, Sun, Moon, Monitor } from "lucide-react";
import { useSettingsStore } from "@/stores/useSettingsStore";

export function AppearanceTab() {
  const { density, setDensity, serifReading, setSerifReading } =
    useSettingsStore();

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2.5">
          <Palette className="w-6 h-6 text-pink-400" />
          <span>外观设置</span>
        </h2>
        <p className="text-xs text-[#8E8E93] mt-1.5 leading-relaxed">
          自定义 Genesis 桌面界面的主题配色、文字排版与布局密度。
        </p>
      </div>

      {/* 主题模式 */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-[#8E8E93] tracking-wide">
          主题风格
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { id: "dark", name: "深色模式 (暗黑极简)", icon: Moon, desc: "默认暗黑风格，保护视力" },
            { id: "light", name: "浅色模式 (明亮白)", icon: Sun, desc: "纯净明亮排版" },
            { id: "system", name: "跟随系统", icon: Monitor, desc: "自动同步系统深浅模式" },
          ].map((theme) => {
            const isDark = theme.id === "dark";
            return (
              <div
                key={theme.id}
                className={`p-4 rounded-2xl border transition-all cursor-pointer ${
                  isDark
                    ? "bg-[#222227] border-blue-500/50 text-white"
                    : "bg-[#18181b]/70 border-[#27272a] text-[#A1A1AA] hover:border-[#3E3E48] hover:text-white"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <theme.icon className={`w-5 h-5 ${isDark ? "text-blue-400" : "text-[#71717A]"}`} />
                  {isDark && <Check className="w-4 h-4 text-blue-400" />}
                </div>
                <div className="text-xs font-semibold">{theme.name}</div>
                <div className="text-[11px] text-[#71717A] mt-1">{theme.desc}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 界面密度 */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-[#8E8E93] tracking-wide">
          界面信息密度
        </h3>
        <div className="bg-[#18181b]/70 border border-[#27272a] rounded-2xl divide-y divide-[#27272a]/60">
          <div className="p-4 sm:p-5 flex items-center justify-between gap-6">
            <div className="space-y-1">
              <div className="text-sm font-medium text-white">排版间隙密度</div>
              <div className="text-xs text-[#8E8E93] leading-relaxed">
                紧凑模式减少卡片与气泡边距，单屏展示更多上下文；舒适模式适合长文沉浸阅读。
              </div>
            </div>
            <div className="flex items-center gap-1.5 p-1 bg-[#141416] border border-[#2C2C33] rounded-xl text-xs">
              <button
                type="button"
                onClick={() => setDensity("comfortable")}
                className={`px-3 py-1 rounded-lg transition-colors cursor-pointer ${
                  density === "comfortable"
                    ? "bg-white/[0.1] text-white font-medium"
                    : "text-[#8E8E93] hover:text-white"
                }`}
              >
                舒适
              </button>
              <button
                type="button"
                onClick={() => setDensity("compact")}
                className={`px-3 py-1 rounded-lg transition-colors cursor-pointer ${
                  density === "compact"
                    ? "bg-white/[0.1] text-white font-medium"
                    : "text-[#8E8E93] hover:text-white"
                }`}
              >
                紧凑
              </button>
            </div>
          </div>

          <div className="p-4 sm:p-5 flex items-center justify-between gap-6">
            <div className="space-y-1">
              <div className="text-sm font-medium text-white">衬线排版模式</div>
              <div className="text-xs text-[#8E8E93] leading-relaxed">
                在 AI 长篇回复中使用优雅纸质衬线体 (Newsreader) 渲染 Markdown 正文；关闭时使用现代无衬线 (Plus Jakarta Sans)。
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={serifReading}
              onClick={() => setSerifReading(!serifReading)}
              className={`w-11 h-6 rounded-full transition-colors relative focus:outline-none cursor-pointer ${
                serifReading ? "bg-[#007AFF]" : "bg-[#3A3A3C]"
              }`}
            >
              <span
                className={`w-5 h-5 bg-white rounded-full absolute top-0.5 shadow-sm transition-transform duration-200 ease-in-out ${
                  serifReading ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
