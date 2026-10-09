"use client";

import React from "react";
import { X, Sparkles } from "lucide-react";

interface ActiveSkillChipProps {
  skillName: string;
  onRemove: () => void;
}

export function ActiveSkillChip({ skillName, onRemove }: ActiveSkillChipProps) {
  return (
    <div className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-full bg-[#2A2A2E] border border-[#3E3E48] text-[#ECECEE] select-none animate-in fade-in zoom-in-95 duration-100">
      <Sparkles className="w-2.5 h-2.5 shrink-0 text-codex-muted" />
      <span className="font-mono text-[11px] font-medium tracking-tight">
        skill:{skillName}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="p-0.5 rounded-full hover:bg-white/[0.1] hover:text-white transition-colors ml-0.5"
        title="移除指定技能"
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </div>
  );
}
