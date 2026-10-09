"use client";

import React, { useEffect } from "react";
import { Sparkles, Terminal, Wrench } from "lucide-react";

export interface SkillOption {
  id: string;
  name: string;
  category: "skill" | "mcp";
  description: string;
}

const AVAILABLE_OPTIONS: SkillOption[] = [
  {
    id: "code-analyzer",
    name: "code-analyzer",
    category: "skill",
    description: "深入静态代码语法与潜在死锁漏洞分析",
  },
  {
    id: "unit-test-generator",
    name: "unit-test-generator",
    category: "skill",
    description: "自动推演并编写高覆盖率 PyTest / Jest 测试用例",
  },
  {
    id: "git-committer",
    name: "git-committer",
    category: "skill",
    description: "规范化提取 Diff 并生成 Conventional Commits",
  },
  {
    id: "web-search",
    name: "web-search",
    category: "skill",
    description: "联网实时查询最新技术白皮书与开源库文档",
  },
  {
    id: "mcp__github__create_issue",
    name: "github::create_issue",
    category: "mcp",
    description: "通过 GitHub MCP Server 提交 Issue 跟踪",
  },
  {
    id: "mcp__postgres__query",
    name: "postgres::query",
    category: "mcp",
    description: "执行安全沙箱只读 SQL 查询与元数据探测",
  },
];

interface SkillMentionDropdownProps {
  query: string;
  selectedIndex: number;
  onSelect: (skill: SkillOption) => void;
  onClose: () => void;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
}

export function SkillMentionDropdown({
  query,
  selectedIndex,
  onSelect,
  setSelectedIndex,
}: SkillMentionDropdownProps) {
  const filtered = AVAILABLE_OPTIONS.filter((opt) =>
    opt.name.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex, setSelectedIndex]);

  if (filtered.length === 0) {
    return (
      <div className="absolute left-0 bottom-full mb-2 w-80 bg-elevated border border-hairline rounded-lg p-3 shadow-2xl z-50 text-xs text-genesis-muted text-center animate-in fade-in zoom-in-95 duration-100">
        未找到匹配的 Skill 或 MCP 工具
      </div>
    );
  }

  const skills = filtered.filter((item) => item.category === "skill");
  const mcps = filtered.filter((item) => item.category === "mcp");

  let globalIndex = 0;

  return (
    <div className="absolute left-0 bottom-full mb-2 w-[340px] max-h-72 overflow-y-auto bg-[#1C1C20] border border-[#2B2B31] rounded-xl py-1.5 shadow-2xl z-50 animate-in fade-in slide-in-from-bottom-2 duration-150 scrollbar-thin select-none text-codex-text">
      {skills.length > 0 && (
        <div className="space-y-0.5">
          <div className="px-3 py-1 text-[10px] font-mono font-medium text-codex-muted uppercase tracking-wider flex items-center gap-1.5">
            <Sparkles className="w-3 h-3 text-codex-muted" />
            <span>已安装 Skill</span>
          </div>
          {skills.map((item) => {
            const isSelected = globalIndex === selectedIndex;
            const currentIndex = globalIndex++;
            return (
              <div
                key={item.id}
                onClick={() => onSelect(item)}
                onMouseEnter={() => setSelectedIndex(currentIndex)}
                className={`px-3 py-1.5 mx-1 rounded-lg text-xs cursor-pointer flex items-start gap-2.5 transition-colors ${
                  isSelected
                    ? "bg-white/[0.08] text-white"
                    : "text-codex-muted hover:bg-white/[0.04] hover:text-white"
                }`}
              >
                <Terminal className="w-3.5 h-3.5 text-codex-muted mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-xs font-medium text-white flex items-center justify-between">
                    <span>/{item.name}</span>
                    <span className="text-[10px] font-mono text-codex-subtle">
                      Skill
                    </span>
                  </div>
                  <p className="text-[11px] text-codex-muted truncate mt-0.5">
                    {item.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {mcps.length > 0 && (
        <div className="space-y-0.5 mt-1 pt-1 border-t border-hairline/60">
          <div className="px-3 py-1 text-[10px] font-mono font-medium text-codex-muted uppercase tracking-wider flex items-center gap-1.5">
            <Wrench className="w-3 h-3 text-codex-muted" />
            <span>MCP 工具</span>
          </div>
          {mcps.map((item) => {
            const isSelected = globalIndex === selectedIndex;
            const currentIndex = globalIndex++;
            return (
              <div
                key={item.id}
                onClick={() => onSelect(item)}
                onMouseEnter={() => setSelectedIndex(currentIndex)}
                className={`px-3 py-1.5 mx-1 rounded-lg text-xs cursor-pointer flex items-start gap-2.5 transition-colors ${
                  isSelected
                    ? "bg-white/[0.08] text-white"
                    : "text-codex-muted hover:bg-white/[0.04] hover:text-white"
                }`}
              >
                <Wrench className="w-3.5 h-3.5 text-codex-muted mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-xs font-medium text-white flex items-center justify-between">
                    <span>/{item.name}</span>
                    <span className="text-[10px] font-mono text-codex-subtle">
                      MCP
                    </span>
                  </div>
                  <p className="text-[11px] text-codex-muted truncate mt-0.5">
                    {item.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export { AVAILABLE_OPTIONS };
