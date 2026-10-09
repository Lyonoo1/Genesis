"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { Message } from "@/types";
import { useUIStore } from "@/stores/useUIStore";

interface ConversationTimelineRailProps {
  messages: Message[];
  containerRef: React.RefObject<HTMLDivElement>;
}

interface ConversationTurn {
  id: string;
  userMessage: Message;
  assistantMessage?: Message;
  turnNumber: number;
}

export function ConversationTimelineRail({
  messages,
  containerRef,
}: ConversationTimelineRailProps) {
  const { isRightSidebarOpen } = useUIStore();

  const [hoveredTurnId, setHoveredTurnId] = useState<string | null>(null);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  // 容器宽度是否足够显示 Rail（< 640px 时隐藏）
  const [isWide, setIsWide] = useState(true);

  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // 点击后锁定 activeTurnId，防止 scroll 事件立即覆盖
  const isUserClickRef = useRef(false);
  const clickLockTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 将消息按 user/assistant 轮次归并
  const turns = useMemo(() => {
    const result: ConversationTurn[] = [];
    let currentTurn: ConversationTurn | null = null;

    for (const m of messages) {
      if (m.role === "user") {
        currentTurn = {
          id: m.id,
          userMessage: m,
          turnNumber: result.length + 1,
        };
        result.push(currentTurn);
      } else if (currentTurn && m.role === "assistant") {
        currentTurn.assistantMessage = m;
      }
    }
    return result;
  }, [messages]);

  // 监听主滚动容器，联动当前视口最靠前的轮次
  // 点击后 300ms 内不覆盖 activeTurnId
  useEffect(() => {
    const el = containerRef.current;
    if (!el || turns.length === 0) return;

    const handleScroll = () => {
      if (isUserClickRef.current) return; // 点击锁定期间跳过

      const containerRect = el.getBoundingClientRect();
      const thresholdY = containerRect.top + 160;

      let currentActiveId = turns[0].id;
      for (const turn of turns) {
        const target = document.getElementById(`message-turn-${turn.id}`);
        if (target) {
          const rect = target.getBoundingClientRect();
          if (rect.top <= thresholdY) {
            currentActiveId = turn.id;
          }
        }
      }
      setActiveTurnId(currentActiveId);
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => el.removeEventListener("scroll", handleScroll);
  }, [turns, containerRef]);

  // 监听容器宽度，过窄时隐藏 Rail
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setIsWide(entry.contentRect.width >= 640);
      }
    });
    ro.observe(el);
    setIsWide(el.clientWidth >= 640);
    return () => ro.disconnect();
  }, [containerRef]);

  // 点击横线平滑滚动到对应消息，锁定 activeTurnId 300ms
  const handleTurnClick = (turnId: string) => {
    // 先设定选中
    setActiveTurnId(turnId);

    // 锁定，避免 scroll 事件覆盖
    isUserClickRef.current = true;
    if (clickLockTimerRef.current) clearTimeout(clickLockTimerRef.current);
    clickLockTimerRef.current = setTimeout(() => {
      isUserClickRef.current = false;
    }, 600); // 与 scrollIntoView smooth 时长对齐

    const el = document.getElementById(`message-turn-${turnId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const handleMouseEnter = (turnId: string) => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setHoveredTurnId(turnId);
  };

  const handleMouseLeave = () => {
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredTurnId(null);
    }, 120);
  };

  // 右侧边栏打开 或 容器过窄时隐藏
  if (turns.length === 0 || isRightSidebarOpen || !isWide) return null;

  return (
    <div
      className="absolute left-2 sm:left-3.5 top-16 z-20 flex flex-col items-start gap-[10px] select-none pointer-events-auto py-2"
      aria-label="对话时间轴导航"
    >
      {turns.map((turn) => {
        const isActive = activeTurnId === turn.id;
        const isHovered = hoveredTurnId === turn.id;

        return (
          <div
            key={turn.id}
            className="relative flex items-center group py-0.5"
            onMouseEnter={() => handleMouseEnter(turn.id)}
            onMouseLeave={handleMouseLeave}
            onClick={() => handleTurnClick(turn.id)}
          >
            {/* 小横线：激活或悬浮时变宽变白 */}
            <button
              type="button"
              className={`h-[2.5px] rounded-full transition-all duration-200 cursor-pointer block ${
                isActive
                  ? "w-8 sm:w-10 bg-white shadow-[0_0_8px_rgba(255,255,255,0.4)]"
                  : isHovered
                  ? "w-7 bg-white"
                  : "w-2.5 sm:w-3 bg-[#454548] hover:bg-[#8E8E93]"
              }`}
              title={`跳转至第 ${turn.turnNumber} 轮对话`}
            />

            {/* 悬浮预览卡片 */}
            {isHovered && (
              <div
                className="absolute left-9 sm:left-11 top-1/2 -translate-y-1/2 z-50 w-[290px] sm:w-[320px] p-4 bg-[#2C2C2E] border border-[#3E3E42]/80 rounded-2xl shadow-[0_12px_36px_rgba(0,0,0,0.65)] text-left select-text pointer-events-auto animate-in fade-in zoom-in-95 duration-150 backdrop-blur-md"
                onMouseEnter={() => handleMouseEnter(turn.id)}
                onMouseLeave={handleMouseLeave}
              >
                <div className="text-[13.5px] font-medium text-white line-clamp-2 leading-snug mb-2 break-words">
                  {turn.userMessage.content || "（空提问）"}
                </div>

                {turn.assistantMessage?.content ? (
                  <div className="text-[12px] text-[#A1A1A6] line-clamp-4 leading-relaxed font-sans whitespace-pre-wrap break-words">
                    {turn.assistantMessage.content}
                  </div>
                ) : turn.assistantMessage?.status === "streaming" ? (
                  <div className="text-[11.5px] text-[#71717A] italic">
                    思考与回答正在输出...
                  </div>
                ) : (
                  <div className="text-[11.5px] text-[#71717A] italic">
                    暂未生成回复
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
