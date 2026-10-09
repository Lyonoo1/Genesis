"use client";

import React from "react";
import { Keyboard, Command } from "lucide-react";

interface ShortcutItem {
  keys: string[];
  action: string;
  category: "对话与输入" | "导航与窗口" | "系统与全局";
}

const SHORTCUTS: ShortcutItem[] = [
  {
    keys: ["Shift", "Enter"],
    action: "在输入框中换行（多行输入）",
    category: "对话与输入",
  },
  {
    keys: ["Enter"],
    action: "发送消息给大模型",
    category: "对话与输入",
  },
  {
    keys: ["⌘", ","],
    action: "打开 / 关闭全屏设置页面",
    category: "导航与窗口",
  },
  {
    keys: ["⌘", "N"],
    action: "创建全新对话",
    category: "导航与窗口",
  },
  {
    keys: ["⌘", "B"],
    action: "展开或收起左侧边栏",
    category: "导航与窗口",
  },
  {
    keys: ["⌘", "K"],
    action: "聚焦搜索会话与快速指令",
    category: "系统与全局",
  },
  {
    keys: ["Esc"],
    action: "取消编辑或返回上级视图",
    category: "系统与全局",
  },
];

export function ShortcutsTab() {
  const categories = ["对话与输入", "导航与窗口", "系统与全局"] as const;

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2.5">
          <Keyboard className="w-6 h-6 text-emerald-400" />
          <span>键盘快捷键</span>
        </h2>
        <p className="text-xs text-[#8E8E93] mt-1.5 leading-relaxed">
          熟练使用键盘快捷键可大幅提升在 Genesis 辅助工作流中的编写与导航效率。
        </p>
      </div>

      <div className="space-y-6">
        {categories.map((cat) => {
          const list = SHORTCUTS.filter((s) => s.category === cat);
          return (
            <div key={cat} className="space-y-3">
              <h3 className="text-sm font-semibold text-[#8E8E93] tracking-wide">
                {cat}
              </h3>
              <div className="bg-[#18181b]/70 border border-[#27272a] rounded-2xl divide-y divide-[#27272a]/60">
                {list.map((item, idx) => (
                  <div
                    key={idx}
                    className="p-4 sm:p-5 flex items-center justify-between gap-6"
                  >
                    <span className="text-sm text-white font-medium">
                      {item.action}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {item.keys.map((k, kIdx) => (
                        <kbd
                          key={kIdx}
                          className="min-w-[28px] h-7 px-2 flex items-center justify-center text-xs font-mono font-semibold text-[#D4D4D8] bg-[#222226] border border-[#2E2E36] rounded-lg shadow-sm"
                        >
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
