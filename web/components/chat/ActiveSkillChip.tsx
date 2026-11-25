"use client";

import React from "react";
import { X, Sparkles, Compass } from "lucide-react";

interface ActiveSkillChipProps {
  skillName: string;
  label?: string;
  variant?: "mode" | "skill";
  onRemove: () => void;
}

export function ActiveSkillChip({
  skillName,
  label,
  variant = "skill",
  onRemove,
}: ActiveSkillChipProps) {
  const isPlanMode = variant === "mode";
  return (
    <div
      className={`inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-xs select-none animate-in fade-in zoom-in-95 duration-100 border ${
        isPlanMode
          ? "bg-indigo-500/15 border-indigo-400/35 text-indigo-200"
          : "bg-[#2A2A2E] border-[#3E3E48] text-[#ECECEE]"
      }`}
    >
      {isPlanMode ? (
        <Compass className="w-3 h-3 shrink-0 text-indigo-300" />
      ) : (
        <Sparkles className="w-3 h-3 shrink-0 text-amber-300" />
      )}
      <span className="font-mono text-[11px] font-medium tracking-tight">
        @{skillName}
      </span>
      {label && (
        <span
          className={`text-[11px] ${
            isPlanMode ? "text-indigo-200/80" : "text-zinc-400"
          }`}
        >
          {label}
        </span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="p-0.5 rounded-full hover:bg-white/[0.12] hover:text-white transition-colors ml-0.5 cursor-pointer"
        title={isPlanMode ? "退出规划模式" : "移除指定技能"}
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </div>
  );
}
