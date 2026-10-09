"use client";

import React, { useState } from "react";
import { Copy, Edit3, Check, X, CornerDownLeft } from "lucide-react";
import { Message } from "@/types";
import { useChatStore } from "@/stores/useChatStore";

interface UserMessageItemProps {
  message: Message;
}

export function UserMessageItem({ message }: UserMessageItemProps) {
  const { editAndResendMessage } = useChatStore();
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(message.content || "");

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback
    }
  };

  const handleSaveEdit = () => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== message.content) {
      editAndResendMessage(message.session_id, message.id, trimmed);
    }
    setIsEditing(false);
  };

  return (
    <div className="flex flex-col items-end group my-4 relative select-text">
      {/* 消息卡片主容器：Codex 经典深蓝圆角气泡 (截图 #183E76) */}
      <div className="max-w-[85%] rounded-[20px] px-5 py-3 bg-[#183E76] shadow-[0_2px_12px_rgba(24,62,118,0.35)] select-text transition-all">
        {isEditing ? (
          <div className="space-y-2 min-w-[280px]">
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={3}
              className="w-full bg-[#143360] border border-[#2B5FA8] rounded-xl p-2.5 text-[14px] text-white focus:outline-none resize-none font-sans"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSaveEdit();
                } else if (e.key === "Escape") {
                  setIsEditing(false);
                }
              }}
            />
            <div className="flex items-center justify-end gap-2 text-xs">
              <button
                onClick={() => setIsEditing(false)}
                className="px-2.5 py-1 rounded-lg text-white/70 hover:text-white transition-colors flex items-center gap-1"
              >
                <X className="w-3 h-3" />
                <span>取消</span>
              </button>
              <button
                onClick={handleSaveEdit}
                className="px-3 py-1 rounded-lg bg-white hover:bg-neutral-200 text-black transition-colors flex items-center gap-1 font-medium"
              >
                <CornerDownLeft className="w-3 h-3 text-black" />
                <span>保存并重发</span>
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[14.5px] font-sans leading-relaxed text-white whitespace-pre-wrap break-words">
            {message.content}
          </p>
        )}
      </div>

      {/* 截图同款：气泡右下方复制操作 (悬浮或平时微弱显示) */}
      {!isEditing && (
        <div className="flex items-center gap-1 mt-1.5 mr-1 text-[#71717A] opacity-0 group-hover:opacity-100 transition-opacity duration-150 select-none">
          <button
            onClick={handleCopy}
            className="p-1 rounded hover:text-white hover:bg-white/[0.06] transition-colors"
            title="复制正文"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-white" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={() => {
              setEditText(message.content || "");
              setIsEditing(true);
            }}
            className="p-1 rounded hover:text-white hover:bg-white/[0.06] transition-colors"
            title="编辑重发"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
