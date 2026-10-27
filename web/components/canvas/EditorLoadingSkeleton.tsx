"use client";

import React from "react";
import { Loader2 } from "lucide-react";

export function EditorLoadingSkeleton() {
  return (
    <div className="flex-1 w-full h-full flex flex-col bg-[#161618] p-4 select-none relative overflow-hidden animate-pulse">
      {/* 居中加载提示 */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 z-10 pointer-events-none">
        <Loader2 className="w-5 h-5 text-[#8E8E93] animate-spin" />
        <span className="text-xs text-[#8E8E93] font-mono">加载代码编辑器核心...</span>
      </div>

      {/* 模拟代码骨架行 */}
      <div className="space-y-2 opacity-25">
        <div className="flex items-center gap-4">
          <span className="w-6 text-right text-[11px] font-mono text-[#52525B]">1</span>
          <div className="h-3.5 bg-white/10 rounded w-1/4" />
        </div>
        <div className="flex items-center gap-4">
          <span className="w-6 text-right text-[11px] font-mono text-[#52525B]">2</span>
          <div className="h-3.5 bg-white/10 rounded w-1/3" />
        </div>
        <div className="flex items-center gap-4">
          <span className="w-6 text-right text-[11px] font-mono text-[#52525B]">3</span>
          <div className="h-3.5 bg-white/5 rounded w-1/12" />
        </div>
        <div className="flex items-center gap-4">
          <span className="w-6 text-right text-[11px] font-mono text-[#52525B]">4</span>
          <div className="h-3.5 bg-white/10 rounded w-1/2" />
        </div>
        <div className="flex items-center gap-4">
          <span className="w-6 text-right text-[11px] font-mono text-[#52525B]">5</span>
          <div className="h-3.5 bg-white/10 rounded w-3/5" />
        </div>
        <div className="flex items-center gap-4">
          <span className="w-6 text-right text-[11px] font-mono text-[#52525B]">6</span>
          <div className="h-3.5 bg-white/10 rounded w-2/5" />
        </div>
        <div className="flex items-center gap-4">
          <span className="w-6 text-right text-[11px] font-mono text-[#52525B]">7</span>
          <div className="h-3.5 bg-white/5 rounded w-1/12" />
        </div>
        <div className="flex items-center gap-4">
          <span className="w-6 text-right text-[11px] font-mono text-[#52525B]">8</span>
          <div className="h-3.5 bg-white/10 rounded w-1/3" />
        </div>
      </div>
    </div>
  );
}
