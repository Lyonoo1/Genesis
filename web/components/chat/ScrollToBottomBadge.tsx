"use client";

import React from "react";
import { ArrowDown } from "lucide-react";

interface ScrollToBottomBadgeProps {
  visible: boolean;
  onClick: () => void;
  bottomOffset?: number;
  scrollbarWidth?: number;
}

export function ScrollToBottomBadge({
  visible,
  onClick,
  bottomOffset = 150,
  scrollbarWidth = 0,
}: ScrollToBottomBadgeProps) {
  if (!visible) return null;

  return (
    <div
      style={{
        bottom: `${bottomOffset}px`,
        transform:
          scrollbarWidth > 0
            ? `translateX(calc(-50% - ${scrollbarWidth / 2}px))`
            : "translateX(-50%)",
      }}
      className="absolute left-1/2 z-40 pointer-events-auto animate-in fade-in zoom-in-90 duration-200 transition-[bottom] duration-150"
    >
      <button
        type="button"
        onClick={onClick}
        className="w-8 h-8 md:w-9 md:h-9 rounded-full bg-[#202024]/90 hover:bg-[#2B2B32] border border-[#33333C] hover:border-white/20 shadow-[0_4px_16px_rgba(0,0,0,0.5)] flex items-center justify-center text-[#A1A1AA] hover:text-white hover:scale-105 active:scale-95 transition-all duration-150 group cursor-pointer backdrop-blur-md"
        title="滚动到底部"
      >
        <ArrowDown className="w-4 h-4 transition-transform duration-150 group-hover:translate-y-0.5" />
      </button>
    </div>
  );
}

