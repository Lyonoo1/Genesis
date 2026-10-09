"use client";

import React from "react";
import { useChatStore } from "@/stores/useChatStore";
import { UserMessageItem } from "./UserMessageItem";
import { AssistantMessageItem } from "./AssistantMessageItem";
import { Terminal, Sparkles } from "lucide-react";

interface MessageListProps {
  sessionId: string;
  bottomSpacerHeight?: number;
}

export function MessageList({ sessionId, bottomSpacerHeight }: MessageListProps) {
  const { messagesBySession, sendStreamMessage } = useChatStore();
  const messages = messagesBySession[sessionId] || [];

  const handleStarterClick = (prompt: string) => {
    sendStreamMessage(sessionId, prompt);
  };

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] text-center select-none py-12">
        <div className="w-12 h-12 rounded-xl bg-[#1E1E23] border border-hairline flex items-center justify-center mb-4">
          <Terminal className="w-6 h-6 text-codex-muted" />
        </div>
        <h2 className="text-lg font-medium text-white tracking-tight">
          Genesis 智性对话就绪
        </h2>
        <p className="text-xs text-codex-muted max-w-sm mt-1.5 leading-relaxed">
          极简原生架构 · 深度代码推演 · 智能隔离沙箱
        </p>

        {/* 预置引导提问卡片 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-8 w-full max-w-md">
          {[
            "介绍一下沙箱子进程隔离机制",
            "如何使用 MCP Client 发现工具？",
            "会话分支修剪是如何工作的？",
            "查看当前系统的 Token 计费模型",
          ].map((prompt) => (
            <button
              key={prompt}
              onClick={() => handleStarterClick(prompt)}
              className="p-3 rounded-lg border border-hairline bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/20 transition-all text-left text-xs text-codex-muted hover:text-white group flex items-start gap-2"
            >
              <Sparkles className="w-3.5 h-3.5 text-codex-muted shrink-0 mt-0.5 group-hover:text-white transition-colors" />
              <span className="leading-snug">{prompt}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {messages.map((message) => {
        if (message.role === "user") {
          return (
            <div
              key={message.id}
              id={`message-turn-${message.id}`}
              className="scroll-mt-12"
            >
              <UserMessageItem message={message} />
            </div>
          );
        }
        return (
          <div
            key={message.id}
            id={`message-${message.id}`}
            className="scroll-mt-12"
          >
            <AssistantMessageItem message={message} />
          </div>
        );
      })}
      {/* 底部动态安全垫片：随输入框展开高度动态弹性支撑，确保滑到底部时最后一条消息绝不被遮挡 */}
      <div
        style={{ height: `${bottomSpacerHeight || 170}px` }}
        className="w-full shrink-0 pointer-events-none transition-[height] duration-150"
        aria-hidden="true"
      />
    </div>
  );
}

