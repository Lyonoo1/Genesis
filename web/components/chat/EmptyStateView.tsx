"use client";

import React from "react";
import { Compass, Hammer, RefreshCw, Bug } from "lucide-react";

interface EmptyStateViewProps {
  onSelectAction: (prompt: string) => void;
}

const ACTION_CARDS = [
  {
    id: "explore",
    title: "探索并理解代码",
    prompt: "帮我全面分析当前项目的架构设计、核心流程与关键逻辑：",
    icon: Compass,
    colorClass: "text-[#3B82F6]",
    bgHoverClass: "hover:border-[#3B82F6]/40",
  },
  {
    id: "build",
    title: "构建新功能、应用或工具",
    prompt: "我想为当前项目新增一个核心功能，需求如下：",
    icon: Hammer,
    colorClass: "text-[#A855F7]",
    bgHoverClass: "hover:border-[#A855F7]/40",
  },
  {
    id: "review",
    title: "审查代码并提出修改建议",
    prompt: "审查当前项目中的代码质量、潜在风险与可优化项，并给出具体修改建议：",
    icon: RefreshCw,
    colorClass: "text-[#10B981]",
    bgHoverClass: "hover:border-[#10B981]/40",
  },
  {
    id: "fix",
    title: "修复问题和失败",
    prompt: "排查并修复当前运行中的异常报错与失败用例：",
    icon: Bug,
    colorClass: "text-[#F97316]",
    bgHoverClass: "hover:border-[#F97316]/40",
  },
];

export function EmptyStateView({ onSelectAction }: EmptyStateViewProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 -mt-16 select-none animate-in fade-in duration-300">
      {/* 1. 云朵与终端 Mascot 图标 */}
      <div className="relative mb-6 flex items-center justify-center">
        <div className="w-16 h-16 rounded-2xl bg-white/[0.03] border border-white/10 flex items-center justify-center text-codex-muted shadow-inner">
          <span className="font-mono text-xl font-bold tracking-tighter text-codex-muted">
            {`>_`}
          </span>
        </div>
      </div>

      {/* 2. 主标语 */}
      <h2 className="text-2xl md:text-3xl font-normal text-white tracking-tight mb-8">
        我们该构建什么？
      </h2>

      {/* 3. 4 个快捷操作彩色卡片网格 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 max-w-4xl w-full">
        {ACTION_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => onSelectAction(card.prompt)}
              className={`p-4 rounded-xl bg-[#18181B]/80 hover:bg-[#202026] border border-hairline ${card.bgHoverClass} text-left transition-all duration-200 group flex flex-col justify-between h-28 shadow-sm hover:shadow-md cursor-pointer`}
            >
              <Icon className={`w-5 h-5 ${card.colorClass} transition-transform group-hover:scale-110`} />
              <div className="text-xs font-medium text-codex-text group-hover:text-white leading-snug">
                {card.title}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
