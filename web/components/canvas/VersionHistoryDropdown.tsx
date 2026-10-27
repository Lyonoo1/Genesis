"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  History,
  Check,
  RotateCcw,
  GitCompare,
  Plus,
  Clock,
  ChevronDown,
} from "lucide-react";
import { CanvasSnapshot, useCanvasStore } from "@/stores/useCanvasStore";

interface VersionHistoryDropdownProps {
  snapshots: CanvasSnapshot[];
  currentIndex: number;
  compareIndex: number | null;
}

export function VersionHistoryDropdown({
  snapshots,
  currentIndex,
  compareIndex,
}: VersionHistoryDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const {
    restoreSnapshot,
    setCompareSnapshotIndex,
    setViewMode,
    createSnapshot,
  } = useCanvasStore();

  const currentSnapshot = snapshots[currentIndex] || snapshots[0];

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div className="relative inline-block" ref={dropdownRef}>
      {/* 触发器按钮 */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[#222226] hover:bg-[#2A2A2E] border border-white/10 text-xs text-[#ECECED] transition-colors cursor-pointer select-none"
        title="查看版本快照历史与回滚"
      >
        <History className="w-3.5 h-3.5 text-blue-400" />
        <span className="font-mono font-medium">
          v{currentSnapshot?.version || 1}
        </span>
        <span className="text-[10px] text-[#8E8E93] max-w-[70px] truncate">
          {currentSnapshot?.timestamp}
        </span>
        <ChevronDown
          className={`w-3 h-3 text-[#71717A] transition-transform duration-200 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* 弹出的历史记录下拉面板 */}
      {isOpen && (
        <div className="absolute left-0 mt-1.5 w-72 rounded-xl bg-[#1C1C1F] border border-[#2E2E33] shadow-2xl z-50 overflow-hidden text-xs text-[#ECECED] animate-in fade-in slide-in-from-top-1 duration-150">
          <div className="px-3 py-2 bg-[#222226] border-b border-[#2E2E33] flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-medium text-white text-[11px]">
              <Clock className="w-3.5 h-3.5 text-blue-400" />
              <span>版本历史快照 ({snapshots.length})</span>
            </div>
            <button
              type="button"
              onClick={() => {
                createSnapshot();
                setIsOpen(false);
              }}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 text-[11px] font-medium transition-colors cursor-pointer"
            >
              <Plus className="w-3 h-3" />
              <span>存为新快照</span>
            </button>
          </div>

          {/* 快照列表 */}
          <div className="max-h-64 overflow-y-auto p-1.5 space-y-1 scrollbar-thin">
            {[...snapshots].reverse().map((snap) => {
              // 计算原数组真实索引
              const originalIdx = snapshots.findIndex((s) => s.id === snap.id);
              const isActive = originalIdx === currentIndex;
              const isComparing =
                compareIndex === originalIdx || (compareIndex === null && originalIdx === 0);

              return (
                <div
                  key={snap.id}
                  className={`p-2 rounded-lg border transition-all ${
                    isActive
                      ? "bg-blue-500/10 border-blue-500/30 text-white"
                      : "bg-[#18181A] hover:bg-[#202024] border-transparent hover:border-white/5"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-semibold text-white">
                        v{snap.version}
                      </span>
                      <span className="text-[10px] text-[#8E8E93] font-mono">
                        {snap.timestamp}
                      </span>
                      {isActive && (
                        <span className="flex items-center gap-0.5 text-[9px] px-1 rounded bg-blue-500/20 text-blue-300 font-mono">
                          <Check className="w-2.5 h-2.5" />
                          <span>当前</span>
                        </span>
                      )}
                      {isComparing && (
                        <span className="text-[9px] px-1 rounded bg-amber-500/20 text-amber-300 font-mono">
                          {compareIndex === null && originalIdx === 0 ? "基准对比源" : "对比源"}
                        </span>
                      )}
                    </div>

                    {/* 差异统计 */}
                    <div className="flex items-center gap-1 font-mono text-[10px]">
                      {snap.additions > 0 && (
                        <span className="text-emerald-400">
                          +{snap.additions}
                        </span>
                      )}
                      {snap.deletions > 0 && (
                        <span className="text-rose-400">
                          -{snap.deletions}
                        </span>
                      )}
                    </div>
                  </div>

                  <p className="text-[11px] text-[#A1A1AA] truncate mb-1.5">
                    {snap.description}
                  </p>

                  {/* 动作按钮组 */}
                  <div className="flex items-center justify-end gap-1 text-[11px] pt-1 border-t border-white/5">
                    <button
                      type="button"
                      onClick={() => {
                        setCompareSnapshotIndex(originalIdx);
                        setViewMode("diff");
                        setIsOpen(false);
                      }}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[#A1A1AA] hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
                      title="对比当前修改与此版本的差异"
                    >
                      <GitCompare className="w-3 h-3 text-amber-400" />
                      <span>对比</span>
                    </button>

                    <button
                      type="button"
                      disabled={isActive}
                      onClick={() => {
                        restoreSnapshot(originalIdx);
                        setIsOpen(false);
                      }}
                      className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
                        isActive
                          ? "opacity-40 cursor-not-allowed text-[#71717A]"
                          : "text-[#A1A1AA] hover:text-white hover:bg-white/[0.08]"
                      }`}
                      title="恢复代码到此版本"
                    >
                      <RotateCcw className="w-3 h-3 text-blue-400" />
                      <span>回滚</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
