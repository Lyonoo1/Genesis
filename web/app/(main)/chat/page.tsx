"use client";

import React, { useEffect, useState } from "react";
import { Sparkles, Terminal, ArrowUpRight, RefreshCw, Radio } from "lucide-react";
import { apiFetch } from "@/lib/api/client";

export default function ChatPage() {
  const [backendText, setBackendText] = useState<string>("正在请求后端数据...");
  const [loading, setLoading] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  const fetchMessage = async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ text: string }>("/api/demo/message");
      setBackendText(data.text);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err: unknown) {
      setBackendText(
        `连接后端失败: ${err instanceof Error ? err.message : "未知错误"}`
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMessage();
  }, []);

  return (
    <div className="h-full flex flex-col justify-center items-center text-center space-y-6">
      <div className="w-12 h-12 rounded-xl bg-accent-cyan/10 border border-accent-cyan/30 flex items-center justify-center drop-shadow-[0_0_12px_rgba(34,211,238,0.25)]">
        <Sparkles className="w-6 h-6 text-accent-cyan" />
      </div>

      <div className="space-y-2">
        <h2 className="text-xl font-medium text-genesis-primary tracking-tight">
          欢迎使用 Genesis 智能体工作台
        </h2>
        <p className="text-sm text-genesis-secondary max-w-md mx-auto">
          极度克制、高密度、零干扰的沉浸式协同环境。支持 MCP 协议接入、安全进程沙箱执行与全双工流式推送。
        </p>
      </div>

      {/* ★ 亲手体验后端接口互动卡片 ★ */}
      <div className="w-full max-w-lg p-4 rounded-xl border border-hairline bg-surface-sidebar/90 shadow-2xl text-left space-y-3">
        <div className="flex items-center justify-between border-b border-hairline pb-2.5">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-accent-cyan animate-pulse" />
            <span className="text-xs font-mono text-genesis-primary font-medium">
              后端接口实时响应 (GET /api/demo/message)
            </span>
          </div>
          <button
            onClick={fetchMessage}
            disabled={loading}
            className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-mono border border-hairline hover:border-hairline-hover hover:bg-white/[0.04] text-genesis-secondary hover:text-genesis-primary transition-all disabled:opacity-50"
          >
            <RefreshCw
              className={`w-3 h-3 ${loading ? "animate-spin text-accent-cyan" : ""}`}
            />
            <span>{loading ? "拉取中..." : "刷新文案"}</span>
          </button>
        </div>

        {/* 动态文案显示区 */}
        <div className="p-3 rounded-lg bg-void border border-hairline/80 font-mono text-sm text-accent-cyan break-words">
          {backendText}
        </div>

        <div className="flex items-center justify-between text-[11px] text-genesis-muted">
          <span>
            文件位置: <code className="text-genesis-secondary font-mono">Genesis/api/main.py</code> (第 105 行)
          </span>
          {lastUpdated && <span>更新于: {lastUpdated}</span>}
        </div>
      </div>

      {/* 功能卡片 */}
      <div className="grid grid-cols-2 gap-3 max-w-lg w-full pt-2">
        <div className="p-3.5 rounded-lg border border-hairline bg-surface-sidebar hover:border-hairline-hover transition-colors text-left space-y-1">
          <div className="flex items-center justify-between text-xs text-genesis-primary font-medium">
            <span className="flex items-center gap-1.5">
              <Terminal className="w-3.5 h-3.5 text-accent-cyan" />
              架构与代码生成
            </span>
            <ArrowUpRight className="w-3 h-3 text-genesis-muted" />
          </div>
          <p className="text-[11px] text-genesis-secondary">
            基于多态上下文与 AST 渲染执行复杂任务
          </p>
        </div>

        <div className="p-3.5 rounded-lg border border-hairline bg-surface-sidebar hover:border-hairline-hover transition-colors text-left space-y-1">
          <div className="flex items-center justify-between text-xs text-genesis-primary font-medium">
            <span className="flex items-center gap-1.5">
              <Terminal className="w-3.5 h-3.5 text-accent-amber" />
              MCP &amp; 工具协同
            </span>
            <ArrowUpRight className="w-3 h-3 text-genesis-muted" />
          </div>
          <p className="text-[11px] text-genesis-secondary">
            无缝连接外部远程 Tool 服务与自定义插件
          </p>
        </div>
      </div>
    </div>
  );
}
