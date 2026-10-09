"use client";

import React from "react";
import { Image as ImageIcon, BookOpen, Terminal, Wrench, Database, GitFork } from "lucide-react";

interface SkillIconProps {
  iconType?: string;
  className?: string;
}

export function SkillIcon({ iconType = "cube", className = "w-9 h-9" }: SkillIconProps) {
  if (iconType === "image") {
    return (
      <div
        className={`${className} rounded-xl bg-gradient-to-br from-sky-400 to-blue-600 p-0.5 flex items-center justify-center shrink-0 shadow-sm`}
      >
        <div className="w-full h-full rounded-[10px] bg-[#1E88E5] flex items-center justify-center">
          <ImageIcon className="w-5 h-5 text-white" />
        </div>
      </div>
    );
  }

  if (iconType === "book") {
    return (
      <div
        className={`${className} rounded-xl bg-[#2A2322] border border-[#44302E] p-1 flex items-center justify-center shrink-0 shadow-sm`}
      >
        <BookOpen className="w-5 h-5 text-[#F97316]" />
      </div>
    );
  }

  if (iconType === "git") {
    return (
      <div
        className={`${className} rounded-xl bg-[#232328] border border-[#353540] flex items-center justify-center shrink-0 shadow-sm text-neutral-300`}
      >
        <GitFork className="w-5 h-5" />
      </div>
    );
  }

  if (iconType === "database") {
    return (
      <div
        className={`${className} rounded-xl bg-[#232328] border border-[#353540] flex items-center justify-center shrink-0 shadow-sm text-neutral-300`}
      >
        <Database className="w-5 h-5" />
      </div>
    );
  }

  if (iconType === "code") {
    return (
      <div
        className={`${className} rounded-xl bg-[#232328] border border-[#353540] flex items-center justify-center shrink-0 shadow-sm text-neutral-300`}
      >
        <Terminal className="w-5 h-5" />
      </div>
    );
  }

  if (iconType === "tool") {
    return (
      <div
        className={`${className} rounded-xl bg-[#232328] border border-[#353540] flex items-center justify-center shrink-0 shadow-sm text-neutral-300`}
      >
        <Wrench className="w-5 h-5" />
      </div>
    );
  }

  // 默认 Codex 经典 3D 棱镜立方体 (Isometric 3D Cube)
  return (
    <div
      className={`${className} rounded-xl bg-[#222227] border border-[#2F2F37] flex items-center justify-center shrink-0 shadow-sm overflow-hidden`}
    >
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
        {/* 顶部表面 (浅粉/浅黄高光) */}
        <polygon points="12,3 20,7.5 12,12 4,7.5" fill="#FBBF24" fillOpacity="0.9" />
        {/* 左侧侧面 (洋红/粉紫微暗) */}
        <polygon points="4,7.5 12,12 12,21 4,16.5" fill="#EC4899" fillOpacity="0.85" />
        {/* 右侧侧面 (深靛青/冷紫暗面) */}
        <polygon points="12,12 20,7.5 20,16.5 12,21" fill="#8B5CF6" fillOpacity="0.95" />
      </svg>
    </div>
  );
}
