"use client";

import React, { useEffect } from "react";
import { Compass, Sparkles, Terminal, Wrench, Zap, Bug, ShieldCheck, FlaskConical } from "lucide-react";

export interface SkillOption {
  id: string;
  name: string;
  label?: string;
  category: "mode" | "skill" | "mcp";
  description: string;
  modeValue?: "plan" | "act";
}

export const BUILTIN_MENTION_OPTIONS: SkillOption[] = [
  {
    id: "mode-plan",
    name: "plan",
    label: "规划模式",
    category: "mode",
    modeValue: "plan",
    description: "只读探索代码库并输出待审批实现方案，拦截所有写操作",
  },
  {
    id: "mode-act",
    name: "act",
    label: "执行模式",
    category: "mode",
    modeValue: "act",
    description: "恢复默认全功能读写编辑与命令执行模式",
  },
  {
    id: "code-review",
    name: "code-review",
    label: "代码审查",
    category: "skill",
    description: "深度分析代码质量、边界缺陷、安全风险与重构建议",
  },
  {
    id: "unit-test",
    name: "unit-test",
    label: "单测生成",
    category: "skill",
    description: "自动推演边界场景并编写高覆盖率 PyTest / Jest 单元测试",
  },
  {
    id: "debug",
    name: "debug",
    label: "根因排查",
    category: "skill",
    description: "系统性定位报错日志、调用链与最小化修复方案",
  },
];

// 兼容旧导入名
export const AVAILABLE_OPTIONS = BUILTIN_MENTION_OPTIONS;

interface SkillMentionDropdownProps {
  query: string;
  selectedIndex: number;
  onSelect: (skill: SkillOption) => void;
  onClose: () => void;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  extraOptions?: SkillOption[];
}

export function filterMentionOptions(
  query: string,
  extraOptions: SkillOption[] = []
): SkillOption[] {
  const seen = new Set<string>();
  const merged: SkillOption[] = [];
  for (const item of [...BUILTIN_MENTION_OPTIONS, ...extraOptions]) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  const q = query.trim().toLowerCase();
  if (!q) return merged;
  return merged.filter(
    (opt) =>
      opt.name.toLowerCase().includes(q) ||
      (opt.label && opt.label.toLowerCase().includes(q)) ||
      opt.description.toLowerCase().includes(q)
  );
}

function getOptionIcon(item: SkillOption) {
  if (item.category === "mode") {
    return item.modeValue === "plan" ? (
      <Compass className="w-3.5 h-3.5 text-indigo-400 mt-0.5 shrink-0" />
    ) : (
      <Zap className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" />
    );
  }
  if (item.id === "code-review") {
    return <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />;
  }
  if (item.id === "unit-test") {
    return <FlaskConical className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />;
  }
  if (item.id === "debug") {
    return <Bug className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />;
  }
  if (item.category === "mcp") {
    return <Wrench className="w-3.5 h-3.5 text-sky-400 mt-0.5 shrink-0" />;
  }
  return <Terminal className="w-3.5 h-3.5 text-zinc-400 mt-0.5 shrink-0" />;
}

export function SkillMentionDropdown({
  query,
  selectedIndex,
  onSelect,
  setSelectedIndex,
  extraOptions = [],
}: SkillMentionDropdownProps) {
  const filtered = filterMentionOptions(query, extraOptions);

  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex, setSelectedIndex]);

  if (filtered.length === 0) {
    return (
      <div className="absolute left-0 bottom-full mb-2 w-80 bg-[#1C1C20] border border-[#2B2B31] rounded-xl p-3 shadow-2xl z-50 text-xs text-zinc-400 text-center animate-in fade-in zoom-in-95 duration-100">
        未找到匹配的模式或技能
      </div>
    );
  }

  const modes = filtered.filter((item) => item.category === "mode");
  const skills = filtered.filter((item) => item.category === "skill");
  const mcps = filtered.filter((item) => item.category === "mcp");

  let globalIndex = 0;

  const renderSection = (
    title: string,
    icon: React.ReactNode,
    items: SkillOption[],
    withDivider: boolean
  ) => {
    if (items.length === 0) return null;
    return (
      <div
        className={`space-y-0.5 ${
          withDivider ? "mt-1 pt-1 border-t border-white/[0.06]" : ""
        }`}
      >
        <div className="px-3 py-1 text-[10px] font-medium text-zinc-500 uppercase tracking-wider flex items-center gap-1.5">
          {icon}
          <span>{title}</span>
        </div>
        {items.map((item) => {
          const currentIndex = globalIndex++;
          const isSelected = currentIndex === selectedIndex;
          return (
            <button
              key={item.id}
              type="button"
              onMouseDown={(e) => {
                // 防止点击菜单抢走 textarea 焦点导致菜单提前卸载
                e.preventDefault();
                onSelect(item);
              }}
              onMouseEnter={() => setSelectedIndex(currentIndex)}
              className={`w-[calc(100%-8px)] mx-1 px-2.5 py-2 rounded-lg text-xs cursor-pointer flex items-start gap-2.5 text-left transition-colors ${
                isSelected
                  ? "bg-white/[0.09] text-white"
                  : "text-zinc-300 hover:bg-white/[0.05] hover:text-white"
              }`}
            >
              {getOptionIcon(item)}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-mono text-xs font-medium text-white truncate">
                      @{item.name}
                    </span>
                    {item.label && (
                      <span className="text-[11px] text-zinc-400 truncate">
                        {item.label}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] font-mono text-zinc-500 shrink-0">
                    {item.category === "mode"
                      ? "模式"
                      : item.category === "mcp"
                      ? "MCP"
                      : "技能"}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-400 truncate mt-0.5">
                  {item.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="absolute left-0 bottom-full mb-2 w-[360px] max-w-[calc(100vw-32px)] max-h-80 overflow-y-auto bg-[#1C1C20] border border-[#2E2E36] rounded-xl py-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.65)] z-50 animate-in fade-in slide-in-from-bottom-2 duration-150 scrollbar-thin select-none text-[#ECECED]">
      {renderSection(
        "协作模式",
        <Compass className="w-3 h-3 text-indigo-400" />,
        modes,
        false
      )}
      {renderSection(
        "快捷技能",
        <Sparkles className="w-3 h-3 text-amber-400" />,
        skills,
        modes.length > 0
      )}
      {renderSection(
        "扩展工具 (MCP)",
        <Wrench className="w-3 h-3 text-sky-400" />,
        mcps,
        modes.length > 0 || skills.length > 0
      )}
      <div className="mt-1 pt-1 px-3 pb-0.5 border-t border-white/[0.06] flex items-center justify-between text-[10px] text-zinc-500">
        <span>↑↓ 选择 · Enter / Tab 确认</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  );
}
