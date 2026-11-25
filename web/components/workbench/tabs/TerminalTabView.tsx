"use client";

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  Terminal as TerminalIcon,
  RotateCcw,
  Trash2,
  Link2,
  Unlink2,
  Bot,
} from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import { XtermCanvas } from "@/components/terminal/XtermCanvas";
import { restartTerminalSession } from "@/lib/api/terminal";
import { useWorkbenchStore } from "@/stores/useWorkbenchStore";

interface TerminalTabViewProps {
  tabId?: string;
  sessionId: string;
  chatSessionId?: string | null;
  isVisible?: boolean;
}

function buildSharedPtySessionId(chatSid?: string | null): string {
  const cleaned = (chatSid || "").trim();
  if (!cleaned || cleaned === "draft") {
    return "pty_default";
  }
  return cleaned.startsWith("pty_") ? cleaned : `pty_${cleaned}`;
}

export function TerminalTabView({
  tabId,
  sessionId,
  chatSessionId,
  isVisible = true,
}: TerminalTabViewProps) {
  const storeActiveSessionId = useWorkbenchStore((s) => s.activeSessionId);
  const updateTab = useWorkbenchStore((s) => s.updateTab);

  const effectiveChatSid = chatSessionId || storeActiveSessionId || "draft";
  const sharedPtyId = useMemo(
    () => buildSharedPtySessionId(effectiveChatSid),
    [effectiveChatSid]
  );

  // 判断当前 Tab 初始是否为独立终端（term-xxx）；否则默认开启人机共管自动绑定
  const isStandaloneInitial = Boolean(
    sessionId && sessionId.startsWith("term-")
  );
  const [autoBindSharedPty, setAutoBindSharedPty] = useState<boolean>(
    !isStandaloneInitial
  );

  // 实际连接到 XtermCanvas 的 PTY session ID：共管模式下恒与当前会话的 pty_{session_id} 保持同步
  const boundSessionId = autoBindSharedPty
    ? sharedPtyId
    : sessionId || sharedPtyId;
  const isSharedCoManaged = boundSessionId === sharedPtyId;

  const [status, setStatus] = useState<
    "connected" | "connecting" | "disconnected"
  >("connecting");
  const [isAgentActive, setIsAgentActive] = useState(false);

  const termInstanceRef = useRef<Terminal | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const hasConnectedWsRef = useRef(false);
  const replayedBufferLenRef = useRef(0);
  const agentActiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    hasConnectedWsRef.current = false;
    replayedBufferLenRef.current = 0;
  }, [boundSessionId]);

  // 当会话切换或草稿会话转正时，若处于共管绑定态则同步写回 Tab 元信息
  useEffect(() => {
    if (autoBindSharedPty && tabId && sessionId !== sharedPtyId) {
      updateTab(tabId, {
        sessionId: sharedPtyId,
        title: "共管终端",
      });
    }
  }, [autoBindSharedPty, tabId, sessionId, sharedPtyId, updateTab]);

  // 监听 StreamDispatcher 广播的 genesis:pty-output：
  // - 点亮 Agent 实时共管活动呼吸灯
  // - 仅在 WebSocket 尚未连通（降级/断连态）时补写到 xterm，防止 WS 已连时出现双倍回显
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handlePtyOutput = (ev: Event) => {
      const customEv = ev as CustomEvent<{
        ptySessionId?: string;
        chunk?: string;
      }>;
      const detail = customEv.detail;
      if (!detail || !detail.chunk) return;
      if (detail.ptySessionId && detail.ptySessionId !== boundSessionId) return;

      setIsAgentActive(true);
      if (agentActiveTimerRef.current) {
        clearTimeout(agentActiveTimerRef.current);
      }
      agentActiveTimerRef.current = setTimeout(() => {
        setIsAgentActive(false);
      }, 2200);

      if (statusRef.current !== "connected" && termInstanceRef.current) {
        try {
          termInstanceRef.current.write(detail.chunk);
          const bufLen =
            useWorkbenchStore.getState().terminalPtyBufferBySession[
              boundSessionId
            ]?.length || 0;
          replayedBufferLenRef.current = Math.max(
            replayedBufferLenRef.current,
            bufLen
          );
        } catch {}
      }
    };

    window.addEventListener("genesis:pty-output", handlePtyOutput);
    return () => {
      window.removeEventListener("genesis:pty-output", handlePtyOutput);
      if (agentActiveTimerRef.current) {
        clearTimeout(agentActiveTimerRef.current);
      }
    };
  }, [boundSessionId]);

  const handleStatusChange = useCallback(
    (st: "connected" | "connecting" | "disconnected") => {
      setStatus(st);
      if (st === "connected") {
        hasConnectedWsRef.current = true;
      } else if (
        st === "disconnected" &&
        !hasConnectedWsRef.current &&
        termInstanceRef.current
      ) {
        // 仅在从未成功连上 WS 的纯 SSE 降级态下，补写此前已缓冲的 SSE PTY 片段
        const buffered =
          useWorkbenchStore.getState().terminalPtyBufferBySession[
            boundSessionId
          ] || [];
        if (buffered.length > replayedBufferLenRef.current) {
          const unseen = buffered.slice(replayedBufferLenRef.current).join("");
          replayedBufferLenRef.current = buffered.length;
          if (unseen) {
            try {
              termInstanceRef.current.write(unseen);
            } catch {}
          }
        }
      }
    },
    [boundSessionId]
  );

  const handleRegisterTerm = useCallback((term: Terminal | null) => {
    termInstanceRef.current = term;
  }, []);

  const handleClear = () => {
    if (termInstanceRef.current) {
      termInstanceRef.current.clear();
    }
  };

  const handleRestart = async () => {
    try {
      await restartTerminalSession(boundSessionId);
      if (termInstanceRef.current) {
        termInstanceRef.current.clear();
      }
    } catch (err) {
      console.error("重启终端失败:", err);
    }
  };

  const handleToggleCoManaged = () => {
    if (autoBindSharedPty) {
      const standaloneId = `term-${Date.now()}`;
      setAutoBindSharedPty(false);
      if (tabId) {
        updateTab(tabId, {
          sessionId: standaloneId,
          title: "独立终端",
        });
      }
    } else {
      setAutoBindSharedPty(true);
      if (tabId) {
        updateTab(tabId, {
          sessionId: sharedPtyId,
          title: "共管终端",
        });
      }
    }
  };

  const shortPtyLabel =
    boundSessionId.length > 26
      ? `${boundSessionId.slice(0, 14)}…${boundSessionId.slice(-8)}`
      : boundSessionId;

  return (
    <div className="flex flex-col w-full h-full bg-[#141416] text-[#ECECED]">
      {/* 终端控制顶栏 */}
      <div className="h-9 px-3 bg-[#18181A] border-b border-[#26262A] flex items-center justify-between shrink-0 text-xs gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <TerminalIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span
            className="font-mono text-[11px] text-[#A1A1AA] truncate"
            title={`PTY Session: ${boundSessionId}`}
          >
            {shortPtyLabel}
          </span>
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              status === "connected"
                ? "bg-emerald-400"
                : status === "connecting"
                ? "bg-amber-400 animate-pulse"
                : "bg-rose-400"
            }`}
            title={`WebSocket: ${status}`}
          />

          {/* 人机同屏共管状态徽章 */}
          {isSharedCoManaged && (
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border shrink-0 transition-colors ${
                isAgentActive
                  ? "bg-sky-500/20 text-sky-200 border-sky-400/40"
                  : "bg-emerald-500/10 text-emerald-300/90 border-emerald-500/25"
              }`}
              title={`已自动绑定当前会话活跃 PTY (${sharedPtyId})：Agent 执行的 exec_command/write_stdin 与您的手动输入实时同屏共享`}
            >
              <Bot
                className={`w-2.5 h-2.5 shrink-0 ${
                  isAgentActive ? "text-sky-300 animate-pulse" : "text-emerald-400"
                }`}
              />
              <span className="hidden sm:inline">
                {isAgentActive ? "Agent 写入中" : "人机共管"}
              </span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 text-[#8E8E93] shrink-0">
          <button
            type="button"
            onClick={handleToggleCoManaged}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border transition-colors cursor-pointer ${
              isSharedCoManaged
                ? "bg-white/[0.04] hover:bg-white/[0.1] border-white/10 text-zinc-300 hover:text-white"
                : "bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/30 text-amber-200"
            }`}
            title={
              isSharedCoManaged
                ? "当前与 Agent 共管同一会话 PTY，点击切换为独立 Shell"
                : `点击重新绑定至当前会话共管 PTY (${sharedPtyId})`
            }
          >
            {isSharedCoManaged ? (
              <>
                <Link2 className="w-3 h-3 text-emerald-400" />
                <span className="hidden md:inline">共管绑定</span>
              </>
            ) : (
              <>
                <Unlink2 className="w-3 h-3 text-amber-300" />
                <span>绑定共管 PTY</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleClear}
            className="p-1 rounded hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            title="清屏"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleRestart}
            className="p-1 rounded hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            title="重启终端会话"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 终端舞台 */}
      <div className="flex-1 w-full min-h-0 relative bg-[#121214] p-1">
        <XtermCanvas
          sessionId={boundSessionId}
          isVisible={isVisible}
          onStatusChange={handleStatusChange}
          onRegisterTerm={handleRegisterTerm}
        />
      </div>
    </div>
  );
}
