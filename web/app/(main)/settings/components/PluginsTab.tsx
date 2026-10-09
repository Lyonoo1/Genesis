"use client";

import React, { useState } from "react";
import { Puzzle, Check, Sparkles, ExternalLink } from "lucide-react";

interface PluginItem {
  id: string;
  name: string;
  desc: string;
  author: string;
  enabled: boolean;
}

const INITIAL_PLUGINS: PluginItem[] = [
  {
    id: "web-search",
    name: "网络检索 (Web Search)",
    desc: "允许大模型联网获取最新资讯与文档，实时检索搜索引擎",
    author: "Genesis Team",
    enabled: true,
  },
  {
    id: "code-sandbox",
    name: "Python 沙箱代码执行",
    desc: "在安全的隔离环境中执行模型生成的 Python 代码并返回运行结果与图表",
    author: "Genesis Team",
    enabled: true,
  },
  {
    id: "git-integration",
    name: "Git 工作流辅助",
    desc: "自动化生成 Commit 规范信息、审查 Diff 变更与协助分支合并",
    author: "Community",
    enabled: false,
  },
];

export function PluginsTab() {
  const [plugins, setPlugins] = useState<PluginItem[]>(INITIAL_PLUGINS);

  const togglePlugin = (id: string) => {
    setPlugins((prev) =>
      prev.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p))
    );
  };

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2.5">
          <Puzzle className="w-6 h-6 text-indigo-400" />
          <span>插件生态与扩展</span>
        </h2>
        <p className="text-xs text-[#8E8E93] mt-1.5 leading-relaxed">
          管理扩展能力工具，让 Agent 在对话中执行网络检索、代码执行与自动化开发。
        </p>
      </div>

      <div className="space-y-3">
        <div className="bg-[#18181b]/70 border border-[#27272a] rounded-2xl divide-y divide-[#27272a]/60">
          {plugins.map((plugin) => (
            <div
              key={plugin.id}
              className="p-5 flex items-center justify-between gap-6"
            >
              <div className="space-y-1 pr-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white">
                    {plugin.name}
                  </span>
                  <span className="text-[10px] text-[#71717A] font-mono">
                    by {plugin.author}
                  </span>
                </div>
                <div className="text-xs text-[#8E8E93] leading-relaxed">
                  {plugin.desc}
                </div>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={plugin.enabled}
                onClick={() => togglePlugin(plugin.id)}
                className={`w-11 h-6 rounded-full transition-colors relative shrink-0 cursor-pointer ${
                  plugin.enabled ? "bg-[#007AFF]" : "bg-[#3A3A3C]"
                }`}
              >
                <span
                  className={`w-5 h-5 bg-white rounded-full absolute top-0.5 shadow-sm transition-transform duration-200 ease-in-out ${
                    plugin.enabled ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
