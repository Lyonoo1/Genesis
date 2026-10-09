"use client";

import React, { useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface ThinkingAccordionProps {
  reasoning: string;
  isStreaming?: boolean;
  hasContent?: boolean;
  durationMs?: number;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${Math.max(0.1, totalSeconds).toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

export function ThinkingAccordion({
  reasoning,
  isStreaming = false,
  hasContent = false,
  durationMs,
}: ThinkingAccordionProps) {
  // 是否正在进行思维链思考 (推流中且尚未开始输出正文)
  const isThinking = isStreaming && !hasContent;

  // 思考中默认展开；思考完成后自动收起折叠
  const [isOpen, setIsOpen] = useState(isThinking);

  // 计时器：精确到小数点后一位 (单位秒)
  const [seconds, setSeconds] = useState(() => {
    if (durationMs) return durationMs / 1000;
    return 0.1;
  });

  const startTimeRef = useRef<number>(Date.now());
  const hasFinishedThinkingRef = useRef(false);

  // 1. 思考状态生命周期监听：思考中展开，完成瞬间自动收起
  useEffect(() => {
    if (isThinking) {
      setIsOpen(true);
      hasFinishedThinkingRef.current = false;
    } else if (!hasFinishedThinkingRef.current) {
      setIsOpen(false);
      hasFinishedThinkingRef.current = true;
    }
  }, [isThinking]);

  // 2. 思考耗时高频计时器 (每 100ms 更新一次，精准呈现小数点后一位)
  useEffect(() => {
    if (!isThinking) {
      if (durationMs) {
        setSeconds(Math.max(0.1, durationMs / 1000));
      }
      return;
    }

    startTimeRef.current = Date.now();
    const interval = setInterval(() => {
      const elapsed = (Date.now() - startTimeRef.current) / 1000;
      setSeconds(Math.max(0.1, elapsed));
    }, 100);

    return () => clearInterval(interval);
  }, [isThinking, durationMs]);

  if (!reasoning) return null;

  const durationText = formatDuration(seconds);

  return (
    <div className="my-2">
      {/* 顶部纯文本用时：无胶囊包裹，点击切换展开/折叠 */}
      <div className="flex items-center select-none">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="inline-flex items-center gap-1 text-xs text-[#8E8E93] hover:text-[#ECECED] transition-colors cursor-pointer py-0.5 select-none group"
          title={isOpen ? "收起思考过程" : "展开思考过程"}
        >
          <span>用时 {durationText}</span>
          {isOpen ? (
            <ChevronDown className="w-3.5 h-3.5 text-[#6E6E78] group-hover:text-white transition-colors" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-[#6E6E78] group-hover:text-white transition-colors" />
          )}
        </button>
      </div>

      {/* 截图同款极细分割横线 */}
      <div className="w-full border-b border-white/[0.08] mt-2 mb-3.5" />

      {/* 思考内容主体：展开时展示，完全跟正常输出的内容一样 */}
      {isOpen && (
        <div className="text-[#ECECEE] text-[15px] leading-[1.75] font-sans mb-4 select-text">
          <MarkdownRenderer
            content={reasoning}
            isStreaming={isThinking}
          />
        </div>
      )}
    </div>
  );
}

