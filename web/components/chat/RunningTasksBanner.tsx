"use client";

import React, { useEffect } from "react";
import { ChevronDown, Loader2, Square } from "lucide-react";
import { useProcessStore } from "@/stores/useProcessStore";

interface RunningTasksBannerProps {
  sessionId?: string | null;
}

export function RunningTasksBanner({ sessionId }: RunningTasksBannerProps) {
  const {
    runningProcesses,
    isExpanded,
    stoppingPids,
    toggleExpanded,
    fetchProcesses,
    stopProcess,
  } = useProcessStore();

  // 1. 会话初载或切换时拉取该会话后台服务
  useEffect(() => {
    fetchProcesses(sessionId || undefined);
  }, [sessionId, fetchProcesses]);

  // 2. 当有后台任务运行中时，每 3 秒自动轮询，以静默感知进程退出
  useEffect(() => {
    if (runningProcesses.length === 0) return;
    const timer = setInterval(() => {
      fetchProcesses(sessionId || undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [runningProcesses.length, sessionId, fetchProcesses]);

  if (runningProcesses.length === 0) {
    return null;
  }

  const count = runningProcesses.length;
  const label = `${count} task${count > 1 ? "s" : ""} running`;

  return (
    <div className="w-full bg-[#202022] border-b border-[#383838]/60 p-3 select-none text-[#ECECED] rounded-t-[19px]">
      {/* 头部标题与折叠开关 */}
      <div
        onClick={toggleExpanded}
        className="flex items-center justify-between cursor-pointer group"
      >
        <span className="text-xs font-normal text-[#C4C4C8] group-hover:text-white transition-colors">
          {label}
        </span>
        <button
          type="button"
          aria-label={isExpanded ? "收起任务列表" : "展开任务列表"}
          className="p-0.5 text-[#8E8E93] group-hover:text-white transition-colors"
        >
          <ChevronDown
            className={`w-3.5 h-3.5 transition-transform duration-200 ${
              !isExpanded ? "-rotate-90" : ""
            }`}
          />
        </button>
      </div>

      {/* 展开任务列表 */}
      {isExpanded && (
        <div className="mt-2 space-y-1">
          {runningProcesses.map((task) => {
            const isStopping = stoppingPids.includes(task.pid);

            return (
              <div
                key={task.pid}
                className="group flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-white/[0.04] transition-colors relative"
              >
                {/* 左侧：旋转动效 + 命令内容 */}
                <div className="flex items-center gap-2.5 min-w-0 pr-2">
                  <Loader2 className="w-3.5 h-3.5 text-[#8E8E93] animate-spin shrink-0 stroke-[1.8]" />
                  <span className="font-mono text-xs text-[#ECECED] truncate select-all">
                    {task.command}
                  </span>
                </div>

                {/* 右侧：Hover 显现的 Stop Task 按钮 (对标截图) */}
                <div className="flex items-center shrink-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      stopProcess(task.pid);
                    }}
                    disabled={isStopping}
                    className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-2 px-2.5 py-1 rounded-lg bg-[#2D2D30] hover:bg-[#38383D] active:scale-95 border border-white/10 text-xs text-[#ECECED] hover:text-white transition-all cursor-pointer shadow-sm disabled:opacity-50"
                    title="停止此服务"
                  >
                    <span>Stop Task</span>
                    {isStopping ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-white shrink-0" />
                    ) : (
                      <span className="flex items-center justify-center w-3.5 h-3.5 rounded-full border border-white/40 shrink-0">
                        <Square className="w-1.5 h-1.5 fill-current text-white" />
                      </span>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
