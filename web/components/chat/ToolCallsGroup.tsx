"use client";

import React, { useState } from "react";
import { ChevronRight, Check, Loader2, X, Terminal, FileCode, FilePlus, Eye, ListTree, Trash2, LucideIcon } from "lucide-react";
import { ToolCallItem } from "@/types";
import { ToolCallAccordion } from "./ToolCallAccordion";

interface ToolCallsGroupProps {
  toolCalls: ToolCallItem[];
  isStreaming?: boolean;
}

// 提取工具的人类可读摘要与语义图标
function getToolSummary(name: string, args?: Record<string, unknown>): { icon: LucideIcon; label: string } {
  if (name.includes("read_file")) {
    const p = (args?.path as string) || "";
    return { icon: Eye, label: p ? `读取 ${p}` : "读取文件" };
  }
  if (name.includes("write_file") || name.includes("create_file")) {
    const p = (args?.path as string) || "";
    return { icon: FilePlus, label: p ? `写入 ${p}` : "写入文件" };
  }
  if (name.includes("edit_file")) {
    const p = (args?.path as string) || "";
    return { icon: FileCode, label: p ? `编辑 ${p}` : "编辑文件" };
  }
  if (name.includes("delete_file")) {
    const p = (args?.path as string) || "";
    return { icon: Trash2, label: p ? `删除 ${p}` : "删除文件" };
  }
  if (name.includes("list_dir")) {
    const p = (args?.path as string) || "";
    return { icon: ListTree, label: p ? `浏览 ${p}` : "列出目录" };
  }
  if (name.includes("execute_command")) {
    const cmd = String(args?.command || "").trim();
    const shortCmd = cmd.length > 30 ? `${cmd.slice(0, 30)}...` : cmd;
    return { icon: Terminal, label: shortCmd ? `执行 ${shortCmd}` : "终端命令" };
  }
  return { icon: Terminal, label: name };
}

export function ToolCallsGroup({ toolCalls, isStreaming }: ToolCallsGroupProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (!toolCalls || toolCalls.length === 0) return null;

  // 单个工具调用直接展示独立卡片
  if (toolCalls.length === 1) {
    const tc = toolCalls[0];
    return (
      <ToolCallAccordion
        toolCall={tc}
        isStreaming={isStreaming}
        toolResult={
          tc.output !== undefined
            ? {
                output: tc.output,
                error: tc.status === "failed" ? (typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output)) : undefined,
                latencyMs: tc.latency_ms,
              }
            : undefined
        }
      />
    );
  }

  // 多个工具调用时聚合展示
  const finishedCount = toolCalls.filter(
    (t) => t.output !== undefined || t.status === "success" || t.status === "failed"
  ).length;
  // 关键规则：只要当前非推流状态 (!isStreaming)，则认定为全部完成，绝不卡在'正在执行'
  const isAllDone = !isStreaming || finishedCount >= toolCalls.length;
  const hasError = toolCalls.some((t) => t.status === "failed");
  const runningTool = isAllDone
    ? undefined
    : toolCalls.find((t) => t.output === undefined && t.status !== "success" && t.status !== "failed") || toolCalls[0];

  // 计算已完成工具的总耗时
  const totalLatencyMs = toolCalls.reduce((acc, cur) => acc + (cur.latency_ms || 0), 0);
  const latencyDisplay = totalLatencyMs > 0 ? `${(totalLatencyMs / 1000).toFixed(1)}s` : null;

  return (
    <div className="my-2 rounded-lg border border-hairline bg-[#161619] overflow-hidden select-none transition-all shadow-sm">
      {/* 1. 聚合胶囊栏 (单行高度 34px) */}
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="h-8.5 px-3 py-1.5 flex items-center justify-between cursor-pointer hover:bg-white/[0.04] transition-colors"
      >
        {/* 左侧状态与动态执行指示 */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {!isAllDone ? (
            <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin shrink-0" />
          ) : hasError ? (
            <div className="w-3.5 h-3.5 rounded-full bg-red-500/20 flex items-center justify-center shrink-0">
              <X className="w-2.5 h-2.5 text-red-400" />
            </div>
          ) : (
            <div className="w-3.5 h-3.5 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
              <Check className="w-2.5 h-2.5 text-emerald-400" />
            </div>
          )}

          <div className="font-mono text-xs text-white/90 truncate flex items-center gap-1.5">
            {!isAllDone && runningTool ? (
              <>
                <span className="text-codex-muted">正在执行</span>
                <span className="font-medium text-white truncate">
                  {getToolSummary(runningTool.name, runningTool.args).label}
                </span>
                <span className="text-codex-muted">
                  ({finishedCount + 1}/{toolCalls.length})
                </span>
              </>
            ) : (
              <>
                <span className="text-codex-muted font-normal">已完成</span>
                <span className="font-medium text-white">
                  {toolCalls.length} 项工具调用
                </span>
                {hasError && <span className="text-red-400 text-[11px]">(含报错)</span>}
              </>
            )}
          </div>
        </div>

        {/* 右侧耗时与展开控制 */}
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {latencyDisplay && (
            <span className="font-mono text-[11px] text-codex-muted">
              {latencyDisplay}
            </span>
          )}
          <span className="text-[11px] text-codex-muted font-sans hidden sm:inline">
            {isOpen ? "收起" : "展开"}
          </span>
          <ChevronRight
            className={`w-3.5 h-3.5 text-codex-muted transition-transform duration-200 ${
              isOpen ? "rotate-90 text-white" : ""
            }`}
          />
        </div>
      </div>

      {/* 2. 展开抽屉：展示全部详细工具调用条目 */}
      {isOpen && (
        <div className="border-t border-hairline bg-[#111113] p-2 space-y-1.5 animate-in fade-in duration-150">
          {toolCalls.map((tc) => (
            <ToolCallAccordion
              key={tc.id}
              toolCall={tc}
              isStreaming={isStreaming}
              toolResult={
                tc.output !== undefined
                  ? {
                      output: tc.output,
                      error:
                        tc.status === "failed"
                          ? typeof tc.output === "string"
                            ? tc.output
                            : JSON.stringify(tc.output)
                          : undefined,
                      latencyMs: tc.latency_ms,
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
