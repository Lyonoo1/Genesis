"use client";

import React, { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { MessageList } from "./MessageList";
import { ChatInputBar } from "./ChatInputBar";
import { ScrollToBottomBadge } from "./ScrollToBottomBadge";
import { EmptyStateView } from "./EmptyStateView";
import { ConversationTimelineRail } from "./ConversationTimelineRail";
import { useStickyScroll } from "@/hooks/useStickyScroll";
import { useChatStore } from "@/stores/useChatStore";
import { useSessionStore } from "@/stores/useSessionStore";

interface MessageContainerProps {
  sessionId?: string | null;
}

export function MessageContainer({ sessionId }: MessageContainerProps) {
  const router = useRouter();
  const { messagesBySession, sendStreamMessage, fetchMessages } = useChatStore();
  const { activeProjectId, createSession, setActiveSessionId } = useSessionStore();
  const [prefilledPrompt, setPrefilledPrompt] = React.useState("");

  const [localSessionId, setLocalSessionId] = React.useState(sessionId);
  useEffect(() => {
    setLocalSessionId(sessionId);
  }, [sessionId]);

  const activeId = sessionId || localSessionId;

  useEffect(() => {
    if (activeId && !messagesBySession[activeId]) {
      fetchMessages(activeId);
    }
  }, [activeId, messagesBySession, fetchMessages]);

  const messages = useMemo(
    () => (activeId ? messagesBySession[activeId] || [] : []),
    [messagesBySession, activeId]
  );

  const { containerRef, showScrollButton, scrollToBottom, onNewContent } =
    useStickyScroll<HTMLDivElement>();

  // 1. 会话切换时，重置到底部 (若正在流式推流，切勿打断用户视口)
  const prevSessionIdRef = React.useRef(activeId);
  useEffect(() => {
    if (activeId && activeId !== prevSessionIdRef.current) {
      const prev = prevSessionIdRef.current;
      prevSessionIdRef.current = activeId;
      const isStreaming = useChatStore.getState().isStreaming;
      if (!isStreaming || !prev) {
        scrollToBottom(false);
      }
    }
  }, [activeId, scrollToBottom]);

  // 2. 流式增量时，遵从用户意图吸附底部 (若用户上滑阅读则保持原位)
  useEffect(() => {
    if (messages.length > 0) {
      onNewContent();
    }
  }, [messages, onNewContent]);

  const [inputBarHeight, setInputBarHeight] = React.useState(120);
  const [scrollbarWidth, setScrollbarWidth] = React.useState(5);

  // 动态监听滚动容器滚动条占位宽度，确保居底输入框与上方内容/代码块 100% 像素级对齐重合
  const updateScrollbarWidth = React.useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const sw = el.offsetWidth - el.clientWidth;
    setScrollbarWidth(sw > 0 ? sw : 5);
  }, [containerRef]);

  const isEmpty = !activeId || messages.length === 0;

  useEffect(() => {
    updateScrollbarWidth();
  }, [updateScrollbarWidth, isEmpty, sessionId, messages.length]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    updateScrollbarWidth();

    const handleUpdate = () => {
      window.requestAnimationFrame(() => {
        updateScrollbarWidth();
      });
    };

    window.addEventListener("resize", handleUpdate);

    const ro = new ResizeObserver(handleUpdate);
    ro.observe(el);
    if (el.firstElementChild) {
      ro.observe(el.firstElementChild);
    }

    const mo = new MutationObserver(handleUpdate);
    mo.observe(el, { childList: true, subtree: true });

    return () => {
      window.removeEventListener("resize", handleUpdate);
      ro.disconnect();
      mo.disconnect();
    };
  }, [updateScrollbarWidth, containerRef]);

  // 当输入框随多行输入弹性伸缩时，若当前处于贴底阅读状态，联动微调滚动视口确保不遮挡
  const prevInputHeightRef = React.useRef(inputBarHeight);
  useEffect(() => {
    if (prevInputHeightRef.current !== inputBarHeight) {
      const delta = inputBarHeight - prevInputHeightRef.current;
      prevInputHeightRef.current = inputBarHeight;
      const el = containerRef.current;
      if (el && delta !== 0) {
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (dist <= delta + 40) {
          el.scrollTop += delta;
        }
      }
    }
  }, [inputBarHeight, containerRef]);

  const handleSelectEmptyAction = (promptText: string) => {
    setPrefilledPrompt(promptText);
  };

  return (
    <div className="relative w-full h-full flex flex-col overflow-hidden select-text">
      {/* 1. 主纵向滚动区域：恒久挂载，采用 scrollbar-gutter: stable 杜绝滚动条出现引起的版心左右跳动 */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden px-4 md:px-6 pt-4 pb-4 scrollbar-thin select-text [scrollbar-gutter:stable]"
      >
        {isEmpty ? (
          <div className="flex-1 min-h-full flex flex-col justify-center items-center pb-32">
            <EmptyStateView onSelectAction={handleSelectEmptyAction} />
          </div>
        ) : (
          <div className="max-w-3xl mx-auto w-full min-h-full flex flex-col justify-start">
            <MessageList sessionId={activeId || ""} bottomSpacerHeight={inputBarHeight + 24} />
          </div>
        )}
      </div>


      {/* 2. 回到底部悬浮 Badge (动态跟随输入框高度上浮，严禁掉入输入框内部，且水平对齐版心) */}
      {!isEmpty && (
        <ScrollToBottomBadge
          visible={showScrollButton}
          onClick={() => scrollToBottom(true)}
          bottomOffset={inputBarHeight + 14}
          scrollbarWidth={scrollbarWidth}
        />
      )}

      {/* 3. 对话左侧时间轴刻度线 (Minimap Scrubber + Hover Preview) */}
      {!isEmpty && (
        <ConversationTimelineRail
          messages={messages}
          containerRef={containerRef}
        />
      )}

      {/* 4. 居底悬浮命令输入中枢 (动态上报渲染高度，水平宽度与代码块完全重合) */}
      <ChatInputBar
        sessionId={activeId}
        initialPrompt={prefilledPrompt}
        onHeightChange={setInputBarHeight}
        scrollbarWidth={scrollbarWidth}
        onSendWithPrompt={async (prompt) => {
          let targetId = activeId;
          if (!targetId) {
            const newSession = await createSession(
              "新对话",
              activeProjectId || undefined
            );
            targetId = newSession.id;
            setLocalSessionId(targetId);
            setActiveSessionId(targetId);
            router.push(`/chat/${targetId}`);
          }
          scrollToBottom(false);
          sendStreamMessage(targetId, prompt);
          setPrefilledPrompt("");
        }}
      />
    </div>
  );
}
