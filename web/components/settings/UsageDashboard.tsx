"use client";

import React, { useState } from "react";
import { Zap, TrendingUp, DollarSign, Award } from "lucide-react";

interface DataPoint {
  day: string;
  tokens: number;
}

const USAGE_HISTORY: DataPoint[] = [
  { day: "09-01", tokens: 12000 },
  { day: "09-02", tokens: 15400 },
  { day: "09-03", tokens: 9800 },
  { day: "09-04", tokens: 18200 },
  { day: "09-05", tokens: 22100 },
  { day: "09-06", tokens: 14300 },
  { day: "09-07", tokens: 8900 },
  { day: "09-08", tokens: 16500 },
  { day: "09-09", tokens: 21000 },
  { day: "09-10", tokens: 19400 },
  { day: "09-11", tokens: 25600 },
  { day: "09-12", tokens: 28900 },
  { day: "09-13", tokens: 17800 },
  { day: "09-14", tokens: 23400 },
];

export function UsageDashboard() {
  const [hoveredPoint, setHoveredPoint] = useState<DataPoint | null>(null);

  // SVG 坐标计算
  const svgWidth = 540;
  const svgHeight = 160;
  const paddingX = 20;
  const paddingY = 24;

  const maxTokens = Math.max(...USAGE_HISTORY.map((d) => d.tokens)) * 1.15;
  const minTokens = 0;

  const points = USAGE_HISTORY.map((d, index) => {
    const x =
      paddingX +
      (index / (USAGE_HISTORY.length - 1)) * (svgWidth - paddingX * 2);
    const y =
      svgHeight -
      paddingY -
      ((d.tokens - minTokens) / (maxTokens - minTokens)) *
        (svgHeight - paddingY * 2);
    return { ...d, x, y };
  });

  const pathD = points.reduce((acc, curr, index) => {
    return index === 0 ? `M ${curr.x} ${curr.y}` : `${acc} L ${curr.x} ${curr.y}`;
  }, "");

  const areaD = `${pathD} L ${points[points.length - 1].x} ${
    svgHeight - paddingY
  } L ${points[0].x} ${svgHeight - paddingY} Z`;

  return (
    <div className="space-y-6 select-none text-codex-text">
      {/* 1. 三列 KPI 卡片 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <div className="p-4 rounded-xl border border-hairline bg-[#18181C] space-y-1">
          <div className="flex items-center justify-between text-codex-muted text-xs">
            <span>当月 Token 消耗</span>
            <Zap className="w-4 h-4 text-codex-muted" />
          </div>
          <div className="text-xl font-mono font-medium text-white pt-1">
            192,200
          </div>
          <p className="text-[10px] text-codex-muted font-mono">
            较上月 -14.2% (模型上下文剪枝生效)
          </p>
        </div>

        <div className="p-4 rounded-xl border border-hairline bg-[#18181C] space-y-1">
          <div className="flex items-center justify-between text-codex-muted text-xs">
            <span>本月预估费用 (USD)</span>
            <DollarSign className="w-4 h-4 text-codex-muted" />
          </div>
          <div className="text-xl font-mono font-medium text-white pt-1">
            $0.573
          </div>
          <p className="text-[10px] text-codex-muted font-mono">
            结算周期: 2026-09-01 ~ 2026-09-30
          </p>
        </div>

        <div className="p-4 rounded-xl border border-hairline bg-[#18181C] space-y-1">
          <div className="flex items-center justify-between text-codex-muted text-xs">
            <span>最高频调用 Skill</span>
            <Award className="w-4 h-4 text-codex-muted" />
          </div>
          <div className="text-base font-mono font-medium text-white truncate pt-1">
            Frontend Skill
          </div>
          <p className="text-[10px] text-codex-muted font-mono">
            累计触发 48 次 · 平均耗时 290ms
          </p>
        </div>
      </div>

      {/* 2. 单像素折线趋势看板 */}
      <div className="p-5 rounded-xl border border-hairline bg-[#18181C] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-codex-muted" />
            <h4 className="text-xs font-mono font-medium text-white">
              近 14 天 Token 吞吐趋势 (Daily Usage)
            </h4>
          </div>

          {hoveredPoint ? (
            <div className="text-[11px] font-mono text-white flex items-center gap-2">
              <span>日期: {hoveredPoint.day}</span>
              <span>·</span>
              <span>{hoveredPoint.tokens.toLocaleString()} tokens</span>
            </div>
          ) : (
            <span className="text-[11px] font-mono text-codex-muted">
              鼠标悬停查看详情
            </span>
          )}
        </div>

        {/* SVG 折线图 */}
        <div className="w-full overflow-hidden pt-2">
          <svg
            viewBox={`0 0 ${svgWidth} ${svgHeight}`}
            className="w-full h-44 overflow-visible"
          >
            <defs>
              <linearGradient id="tokenGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2563EB" stopOpacity="0.25" />
                <stop offset="100%" stopColor="#2563EB" stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {/* 渐变阴影填充 */}
            <path d={areaD} fill="url(#tokenGradient)" />

            {/* 底部分割线 */}
            <line
              x1={paddingX}
              y1={svgHeight - paddingY}
              x2={svgWidth - paddingX}
              y2={svgHeight - paddingY}
              stroke="rgba(255, 255, 255, 0.08)"
              strokeWidth="1"
            />

            {/* 单像素折线 (Codex 经典蓝色 #2563EB) */}
            <path
              d={pathD}
              fill="none"
              stroke="#2563EB"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {/* 交互拐点 */}
            {points.map((p, idx) => (
              <circle
                key={idx}
                cx={p.x}
                cy={p.y}
                r={hoveredPoint?.day === p.day ? "4" : "2"}
                fill={hoveredPoint?.day === p.day ? "#2563EB" : "#18181C"}
                stroke="#2563EB"
                strokeWidth="1.5"
                className="cursor-pointer transition-all duration-150"
                onMouseEnter={() => setHoveredPoint(p)}
                onMouseLeave={() => setHoveredPoint(null)}
              />
            ))}
          </svg>
        </div>
      </div>

      {/* 3. 模型占比分解 */}
      <div className="p-5 rounded-xl border border-hairline bg-[#18181C] space-y-3">
        <h4 className="text-xs font-mono font-medium text-codex-muted uppercase tracking-wider">
          活跃模型用量占比 (Model Distribution)
        </h4>

        <div className="space-y-2.5 text-xs font-mono">
          <div>
            <div className="flex justify-between text-white mb-1">
              <span>5.5 / 5.6 Terra</span>
              <span>65% (124,930 tokens)</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/[0.05] overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full w-[65%]" />
            </div>
          </div>

          <div>
            <div className="flex justify-between text-codex-muted mb-1">
              <span>GPT-4o</span>
              <span>25% (48,050 tokens)</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/[0.05] overflow-hidden">
              <div className="h-full bg-neutral-500 rounded-full w-[25%]" />
            </div>
          </div>

          <div>
            <div className="flex justify-between text-codex-muted mb-1">
              <span>DeepSeek-V3</span>
              <span>10% (19,220 tokens)</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/[0.05] overflow-hidden">
              <div className="h-full bg-neutral-600 rounded-full w-[10%]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
