"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useConfirmationEngine } from "./engine/useConfirmationEngine";
import { useDockKeyboard } from "./engine/useDockKeyboard";
import { usePlanApprovalBridge } from "./engine/usePlanApprovalBridge";
import { useSessionEventChannel } from "./engine/useSessionEventChannel";
import { MaterialStyle } from "./styles/MaterialStyle";
import { ParchmentStyle } from "./styles/ParchmentStyle";
import { CharcoalStyle } from "./styles/CharcoalStyle";
import type { ConcreteConfirmStyle } from "./types/protocol";

export interface ConfirmationDockProps {
  sessionId: string | null | undefined;
  composerRef?: RefObject<HTMLTextAreaElement | null>;
  composerValue?: string;
  agentName?: string;
  onFillComposerText?: (text: string) => void;
  onSendRedirectMessage?: (text: string) => void;
}

/**
 * Agent 确认交互气泡唯一对外入口：
 * - 挂载在主输入框 ChatInputBar 正上方（Plan 审批也统一在此以 plan_approval 渲染）
 * - 按生效风格分发给三套完全独立的视图渲染器（Material / Parchment / Charcoal）
 * - 键盘监听限定在 Dock 根节点 focus-within 作用域，绝不劫持 Monaco / xterm / 主输入框
 * - 主输入框有焦点且非空时不抢焦点，温和提示「按 Tab 进入审批」
 */
export function ConfirmationDock({
  sessionId,
  composerRef,
  composerValue = "",
  agentName = "Genesis",
  onFillComposerText,
  onSendRedirectMessage,
}: ConfirmationDockProps) {
  const dockRef = useRef<HTMLDivElement | null>(null);
  const restoreDockFocusOnSwapRef = useRef(false);
  const [showTabHint, setShowTabHint] = useState(false);

  useSessionEventChannel(sessionId);
  usePlanApprovalBridge(sessionId, agentName);

  const engine = useConfirmationEngine({
    sessionId,
    composerRef,
    onFillComposerText,
    onSendRedirectMessage,
  });

  const keyboard = useDockKeyboard({
    engine,
    dockRef,
  });

  const requestId = engine.entry?.request.request_id;
  const focusedField = engine.entry?.draft.focusedField ?? null;
  const composerValueRef = useRef(composerValue);
  composerValueRef.current = composerValue;

  // 新请求到达时评估是否自动聚焦（§6.6：主输入框有焦点且非空时不抢焦点）
  useEffect(() => {
    if (!requestId) {
      setShowTabHint(false);
      return;
    }
    const composerEl = composerRef?.current ?? null;
    const composerBusy =
      composerEl !== null &&
      document.activeElement === composerEl &&
      composerValueRef.current.trim().length > 0;

    if (composerBusy) {
      setShowTabHint(true);
    } else {
      setShowTabHint(false);
      dockRef.current?.focus();
    }
  }, [requestId, composerRef]);

  // 导航态热切换风格后，若旧风格子元素卸载导致焦点脱落到 body，自动归还至 Dock 保持键盘可用
  useLayoutEffect(() => {
    if (!restoreDockFocusOnSwapRef.current) return;
    restoreDockFocusOnSwapRef.current = false;
    if (focusedField) return;
    const dockEl = dockRef.current;
    if (dockEl && !dockEl.contains(document.activeElement)) {
      dockEl.focus();
    }
  }, [engine.effectiveStyle, focusedField]);

  if (!engine.entry || !engine.currentItem) {
    return null;
  }

  const handleCycleStyle = (next: ConcreteConfirmStyle) => {
    restoreDockFocusOnSwapRef.current = Boolean(
      dockRef.current && dockRef.current.contains(document.activeElement)
    );
    engine.setStyle(next);
  };

  return (
    <div
      key={engine.entry.request.request_id}
      ref={dockRef}
      tabIndex={-1}
      role="region"
      aria-label="智能体确认交互区"
      data-confirm-style={engine.effectiveStyle}
      data-testid="confirmation-dock"
      className="cf-dock-root mb-2.5 w-full"
      onKeyDown={keyboard.onKeyDown}
      onCompositionStart={keyboard.onCompositionStart}
      onCompositionEnd={keyboard.onCompositionEnd}
      onFocus={() => setShowTabHint(false)}
    >
      {engine.effectiveStyle === "google_aistudio" ? (
        <MaterialStyle
          engine={engine}
          agentName={agentName}
          showTabHint={showTabHint}
          onCycleStyle={handleCycleStyle}
        />
      ) : engine.effectiveStyle === "claude_desktop" ? (
        <ParchmentStyle
          engine={engine}
          agentName={agentName}
          showTabHint={showTabHint}
          onCycleStyle={handleCycleStyle}
        />
      ) : (
        <CharcoalStyle
          engine={engine}
          agentName={agentName}
          showTabHint={showTabHint}
          onCycleStyle={handleCycleStyle}
        />
      )}
    </div>
  );
}
