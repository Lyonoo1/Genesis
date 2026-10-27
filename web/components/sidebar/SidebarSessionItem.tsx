"use client";

import React from "react";
import {
  Pin,
  MoreHorizontal,
  Archive,
  Check,
  X,
  Edit3,
} from "lucide-react";
import { Session } from "@/types";

interface SidebarSessionItemProps {
  session: Session;
  isActive: boolean;
  isMenuOpen: boolean;
  isEditing: boolean;
  editingTitle: string;
  indent?: boolean;
  onSelect: () => void;
  onToggleMenu: () => void;
  onOpenEditModal: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onChangeEditingTitle: (val: string) => void;
  onSaveTitle: () => void;
  onCancelEditing: () => void;
}

export const SidebarSessionItem = React.memo(function SidebarSessionItem({
  session,
  isActive,
  isMenuOpen,
  isEditing,
  editingTitle,
  indent = false,
  onSelect,
  onToggleMenu,
  onOpenEditModal,
  onTogglePin,
  onArchive,
  onChangeEditingTitle,
  onSaveTitle,
  onCancelEditing,
}: SidebarSessionItemProps) {
  if (isEditing) {
    return (
      <div
        className={`flex items-center gap-2 ${
          indent ? "pl-7" : "px-2.5"
        } pr-2.5 h-8 rounded-[8px] bg-[#373839] border border-white/20 w-full`}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="text"
          autoFocus
          value={editingTitle}
          onChange={(e) => onChangeEditingTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onSaveTitle();
            } else if (e.key === "Escape") {
              onCancelEditing();
            }
          }}
          className="w-full bg-transparent text-[13.5px] text-white outline-none border-none p-0"
        />
        <div className="flex items-center gap-0.5 shrink-0 text-[#8E8E93]">
          <button
            type="button"
            onClick={onSaveTitle}
            className="p-1 rounded hover:text-white hover:bg-white/10 transition-colors"
            title="确认 (Enter)"
          >
            <Check className="w-3.5 h-3.5 text-accent-green" />
          </button>
          <button
            type="button"
            onClick={onCancelEditing}
            className="p-1 rounded hover:text-white hover:bg-white/10 transition-colors"
            title="取消 (Esc)"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={onSelect}
      className={`group/session relative flex items-center justify-between ${
        indent ? "pl-7" : "px-2.5"
      } pr-2.5 h-8 rounded-[8px] text-[13.5px] cursor-pointer transition-colors ${
        isActive
          ? "bg-[#373839] text-white font-normal"
          : "text-[#ECECED] hover:bg-white/[0.05] font-normal"
      }`}
    >
      <div className="flex items-center gap-1.5 min-w-0 pr-2">
        {session.pinned && (
          <Pin className="w-3 h-3 text-accent-coral fill-accent-coral shrink-0 rotate-45" />
        )}
        <span className="truncate">{session.title}</span>
      </div>

      {/* 悬浮操作菜单与独立归档按钮组 */}
      <div
        data-menu-container
        className={`flex items-center gap-0.5 ${
          isActive || isMenuOpen
            ? "opacity-100"
            : "opacity-0 group-hover/session:opacity-100"
        } transition-opacity`}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 1. 更多操作按钮 (...) */}
        <div className="relative" data-menu-container>
          <button
            type="button"
            data-menu-container
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMenu();
            }}
            className="p-1 rounded text-[#8E8E93] hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
            title="更多操作"
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>

          {/* 下拉浮层 */}
          {isMenuOpen && (
            <div
              data-menu-container
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-7 z-50 w-36 py-1 bg-[#1E1E20] border border-hairline rounded-lg shadow-xl text-xs space-y-0.5 animate-in fade-in zoom-in-95"
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenEditModal();
                }}
                className="w-full px-2.5 py-1.5 flex items-center gap-2 text-[#ECECED] hover:bg-white/[0.06] text-left cursor-pointer"
              >
                <Edit3 className="w-3.5 h-3.5 text-[#8E8E93]" />
                <span>修改对话信息</span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin();
                }}
                className="w-full px-2.5 py-1.5 flex items-center gap-2 text-[#ECECED] hover:bg-white/[0.06] text-left cursor-pointer"
              >
                <Pin className="w-3.5 h-3.5 text-[#8E8E93]" />
                <span>{session.pinned ? "取消置顶" : "置顶会话"}</span>
              </button>
            </div>
          )}
        </div>

        {/* 2. 独立直接归档按钮 */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onArchive();
          }}
          className="p-1 rounded text-[#8E8E93] hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
          title="直接归档对话"
        >
          <Archive className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
});
