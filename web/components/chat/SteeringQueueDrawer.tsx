"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  GripVertical,
  CornerDownRight,
  Trash2,
  MoreHorizontal,
  Pencil,
  XCircle,
  Loader2,
  Check,
} from "lucide-react";
import { useChatStore, QueuedSteeringItem } from "@/stores/useChatStore";

interface SteeringQueueDrawerProps {
  sessionId?: string | null;
  onFillText?: (text: string) => void;
}

export function SteeringQueueDrawer({
  sessionId,
  onFillText,
}: SteeringQueueDrawerProps) {
  const {
    steeringQueueBySession,
    guideSteeringItem,
    removeSteeringItem,
    clearSteeringQueue,
    reorderSteeringQueue,
  } = useChatStore();

  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [guidingId, setGuidingId] = useState<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const queue = sessionId ? steeringQueueBySession[sessionId] || [] : [];

  // 点击外部关闭弹出的更多操作菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setActiveMenuId(null);
      }
    };
    if (activeMenuId) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [activeMenuId]);

  if (!sessionId || queue.length === 0) {
    return null;
  }

  const handleGuide = async (item: QueuedSteeringItem) => {
    if (guidingId) return;
    setGuidingId(item.id);
    try {
      await guideSteeringItem(sessionId, item.id);
    } finally {
      setTimeout(() => {
        setGuidingId(null);
      }, 500);
    }
  };

  const handleEdit = (item: QueuedSteeringItem) => {
    if (onFillText) {
      onFillText(item.content);
    }
    removeSteeringItem(sessionId, item.id);
    setActiveMenuId(null);
  };

  const handleClear = () => {
    clearSteeringQueue(sessionId);
    setActiveMenuId(null);
  };

  // 拖拽开始
  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
  };

  // 拖拽悬停处理
  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  // 释放放置
  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (draggedIndex !== null && draggedIndex !== targetIndex) {
      reorderSteeringQueue(sessionId, draggedIndex, targetIndex);
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="w-full mb-1.5 z-40 select-none animate-in fade-in slide-in-from-bottom-2 duration-150 relative">
      {/* 
        外层容器：严格去除 overflow-hidden，杜绝向上弹出的 ... 菜单被无情切断！
        首末条目通过 first:rounded-t-2xl last:rounded-b-2xl 自闭合圆角
      */}
      <div className="w-full rounded-2xl border border-white/[0.08] bg-[#222225]/95 backdrop-blur-md shadow-[0_12px_32px_rgba(0,0,0,0.6)] divide-y divide-white/[0.05] relative">
        {queue.map((item, index) => {
          const isGuiding = guidingId === item.id;
          const isMenuOpen = activeMenuId === item.id;
          const isDragging = draggedIndex === index;
          const isDragOver = dragOverIndex === index && draggedIndex !== index;

          return (
            <div
              key={item.id}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              className={`flex items-center justify-between px-3.5 py-2.5 transition-all relative group cursor-grab active:cursor-grabbing first:rounded-t-2xl last:rounded-b-2xl ${
                isDragging
                  ? "opacity-35 scale-[0.99] bg-white/[0.03]"
                  : isDragOver
                  ? "bg-white/[0.08] border-t-2 border-blue-500/80"
                  : "hover:bg-white/[0.02]"
              }`}
            >
              {/* 左侧：hover显现轻量拖拽手柄 + 弯折箭头 ↳ + 文本 (对标图 4 Codex 极简原貌) */}
              <div className="flex items-center gap-2 min-w-0 flex-1 pr-3">
                <div
                  className="w-4 h-4 flex items-center justify-center shrink-0 cursor-grab active:cursor-grabbing"
                  title="按住拖拽调整顺序"
                >
                  <GripVertical className="w-3.5 h-3.5 text-zinc-400 opacity-30 group-hover:opacity-90 transition-opacity" />
                </div>
                <CornerDownRight className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                <span
                  className="text-[13px] text-zinc-100 font-sans truncate select-text leading-normal"
                  title={item.content}
                >
                  {item.content}
                </span>
              </div>

              {/* 右侧：↳ 引导按钮 + 垃圾桶 + 更多菜单 (对标图 4) */}
              <div
                className="flex items-center gap-1.5 shrink-0"
                onMouseDown={(e) => e.stopPropagation()} // 防止触发拖拽
              >
                {/* ↳ 引导 按钮 (对标图 4) */}
                <button
                  type="button"
                  onClick={() => handleGuide(item)}
                  disabled={Boolean(guidingId)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-zinc-200 hover:text-white transition-all cursor-pointer shadow-sm active:scale-95 group/guide"
                  title="立即打断并回答此消息"
                >
                  {isGuiding ? (
                    <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
                  ) : item.status === "guided" ? (
                    <Check className="w-3 h-3 text-emerald-400" />
                  ) : null}
                  <span>{item.status === "guided" ? "已引导" : "↳ 引导"}</span>
                </button>

                {/* 垃圾桶删除 (对标图 4) */}
                <button
                  type="button"
                  onClick={() => removeSteeringItem(sessionId, item.id)}
                  className="p-1.5 rounded-md hover:bg-white/[0.08] text-zinc-400 hover:text-rose-400 transition-colors cursor-pointer"
                  title="删除"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>

                {/* 更多菜单 ... (对标图 4 与 图 5) */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setActiveMenuId(isMenuOpen ? null : item.id)}
                    className="p-1.5 rounded-md hover:bg-white/[0.08] text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                    title="更多操作"
                  >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                  </button>

                  {/* 向上弹出菜单 (无裁切、高 z-index) */}
                  {isMenuOpen && (
                    <div
                      ref={menuRef}
                      className="absolute right-0 bottom-full mb-2 w-40 rounded-xl bg-[#262629] border border-white/[0.12] shadow-[0_16px_36px_rgba(0,0,0,0.8)] p-1 z-50 animate-in fade-in zoom-in-95 duration-100 divide-y divide-white/[0.06]"
                    >
                      <div className="space-y-0.5">
                        <button
                          type="button"
                          onClick={() => handleEdit(item)}
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white/[0.08] text-xs text-zinc-200 hover:text-white transition-colors text-left cursor-pointer"
                        >
                          <Pencil className="w-3.5 h-3.5 text-zinc-400" />
                          <span>编辑消息</span>
                        </button>
                      </div>

                      <div className="pt-0.5 mt-0.5">
                        <button
                          type="button"
                          onClick={handleClear}
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-rose-500/15 text-xs text-rose-300 hover:text-rose-200 transition-colors text-left cursor-pointer"
                        >
                          <XCircle className="w-3.5 h-3.5 text-rose-400" />
                          <span>关闭排队</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
