"use client";

import React from "react";
import { Message } from "@/types";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ThinkingPulse } from "./ThinkingPulse";
import { ThinkingAccordion } from "./ThinkingAccordion";
import { AssistantActionBar } from "./AssistantActionBar";
import { ToolCallAccordion } from "./ToolCallAccordion";
import { useChatStore } from "@/stores/useChatStore";

interface AssistantMessageItemProps {
  message: Message;
}

export function AssistantMessageItem({ message }: AssistantMessageItemProps) {
  const { regenerateAssistantMessage } = useChatStore();

  const isGeneratingWithoutContent =
    message.status === "streaming" && !message.content && !message.reasoning_content;

  const handleRegenerate = () => {
    regenerateAssistantMessage(message.session_id, message.id);
  };

  return (
    <div className="my-6 space-y-2 select-text">
      {/* 1. 思考等待脉冲动效 (在尚未收到任何思考文字或正文前展示) */}
      {isGeneratingWithoutContent && <ThinkingPulse />}

      {/* 2. 深度思考折叠仓 (DeepSeek R1 / o1 思维链) */}
      {message.reasoning_content && (
        <ThinkingAccordion
          reasoning={message.reasoning_content}
          isStreaming={message.status === "streaming"}
          hasContent={!!message.content}
          durationMs={message.metrics?.latency_ms}
        />
      )}

      {/* 3. 工具调用折叠舱 (ToolCallAccordion) */}
      {message.raw_tool_calls && message.raw_tool_calls.length > 0 && (
        <div className="space-y-1.5 my-2.5">
          {message.raw_tool_calls.map((toolCall) => (
            <ToolCallAccordion key={toolCall.id} toolCall={toolCall} />
          ))}
        </div>
      )}

      {/* 4. 智性流式正文渲染 (Claude 质感，零气泡底色) */}
      {message.content && (
        <div className="text-genesis-primary/95">
          <MarkdownRenderer
            content={message.content}
            isStreaming={message.status === "streaming"}
          />
        </div>
      )}

      {/* 5. 底部操作栏与 Token/耗时指标 */}
      {message.status !== "streaming" && (message.content || message.reasoning_content) && (
        <AssistantActionBar
          content={message.content || message.reasoning_content || ""}
          metrics={message.metrics}
          onRegenerate={handleRegenerate}
        />
      )}
    </div>
  );
}
