"use client";

import React, { useState, useRef, useEffect } from "react";
import { Pin, MoreHorizontal, Edit2, Trash2 } from "lucide-react";
import { Session } from "@/types";
import { useSessionStore } from "@/stores/useSessionStore";
import { useRouter, usePathname } from "next/navigation";

interface SessionItemProps {
  session: Session;
}

export function SessionItem({ session }: SessionItemProps) {
  const router = useRouter();
  const pathname = usePathname();
  const {
    activeSessionId,
    setActiveSessionId,
    editingSessionId,
    setEditingSessionId,
    updateSessionTitle,
    togglePinSession,
    openDeleteModal,
  } = useSessionStore();

  const isActive = pathname.startsWith("/chat") && activeSessionId === session.id;
  const isEditing = editingSessionId === session.id;

  const [editTitle, setEditTitle] = useState(session.title);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 进入编辑状态时自动聚焦并全选文本
  useEffect(() => {
    if (isEditing) {
      setEditTitle(session.title);
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 50);
    }
  }, [isEditing, session.title]);

  // 点击菜单外部自动关闭下拉浮层
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    if (isMenuOpen) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [isMenuOpen]);

  const handleSelect = () => {
    if (isEditing) return;
    setActiveSessionId(session.id);
    router.push(`/chat/${session.id}`);
  };

  const handleSaveRename = () => {
    updateSessionTitle(session.id, editTitle);
  };

  const handleCancelRename = () => {
    setEditTitle(session.title);
    setEditingSessionId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelRename();
    }
  };

  return (
    <div
      onClick={handleSelect}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditingSessionId(session.id);
      }}
      className={`group relative h-8 px-2.5 mx-1.5 rounded-[6px] flex items-center justify-between text-xs cursor-pointer select-none transition-all duration-150 ${
        isActive
          ? "bg-white/[0.08] text-white shadow-sm font-medium"
          : "text-codex-muted hover:bg-white/[0.04] hover:text-white"
      }`}
    >
      {/* 标题或行内输入框 */}
      <div className="flex items-center gap-1.5 min-w-0 flex-1 mr-1">
        {session.pinned && (
          <span title="已置顶" className="shrink-0 flex items-center">
            <Pin className="w-3 h-3 text-codex-muted rotate-45" />
          </span>
        )}

        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={handleSaveRename}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
            className="h-6 w-full px-1.5 rounded bg-[#1C1C20] border border-[#383842] text-xs text-white outline-none transition-all"
          />
        ) : (
          <span className="truncate text-xs">{session.title}</span>
        )}
      </div>

      {/* 悬停操作浮层按钮 */}
      {!isEditing && (
        <div
          className={`flex items-center gap-0.5 shrink-0 transition-opacity duration-150 ${
            isMenuOpen
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 置顶快捷按钮 */}
          <button
            onClick={() => togglePinSession(session.id)}
            className={`p-1 rounded hover:bg-white/[0.08] transition-colors ${
              session.pinned ? "text-white" : "text-codex-muted hover:text-white"
            }`}
            title={session.pinned ? "取消置顶" : "置顶会话"}
          >
            <Pin className={`w-3 h-3 ${session.pinned ? "rotate-45" : ""}`} />
          </button>

          {/* 更多菜单开关 */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="p-1 rounded text-genesis-muted hover:text-genesis-primary hover:bg-white/[0.08] transition-colors"
              title="更多操作"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>

            {/* 下拉菜单 */}
            {isMenuOpen && (
              <div className="absolute right-0 top-7 w-32 bg-elevated/95 backdrop-blur-md border border-hairline rounded-lg py-1 shadow-2xl z-50 animate-in fade-in zoom-in-95 duration-100">
                <button
                  onClick={() => {
                    togglePinSession(session.id);
                    setIsMenuOpen(false);
                  }}
                  className="w-full px-2.5 py-1.5 text-[11px] text-left text-codex-muted hover:text-white hover:bg-white/[0.06] flex items-center gap-2 transition-colors"
                >
                  <Pin className="w-3 h-3 text-codex-muted" />
                  <span>{session.pinned ? "取消置顶" : "置顶会话"}</span>
                </button>

                <button
                  onClick={() => {
                    setIsMenuOpen(false);
                    setEditingSessionId(session.id);
                  }}
                  className="w-full px-2.5 py-1.5 text-[11px] text-left text-codex-muted hover:text-white hover:bg-white/[0.06] flex items-center gap-2 transition-colors"
                >
                  <Edit2 className="w-3 h-3 text-codex-muted" />
                  <span>重命名</span>
                </button>

                <div className="my-1 border-t border-hairline/60" />

                <button
                  onClick={() => {
                    setIsMenuOpen(false);
                    openDeleteModal(session.id);
                  }}
                  className="w-full px-2.5 py-1.5 text-[11px] text-left text-red-400 hover:bg-red-500/10 flex items-center gap-2 transition-colors"
                >
                  <Trash2 className="w-3 h-3 text-red-400" />
                  <span>删除会话</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
