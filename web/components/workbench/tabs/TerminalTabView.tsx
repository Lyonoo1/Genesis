"use client";

import React, { useState, useRef, useCallback } from "react";
import { Terminal as TerminalIcon, RotateCcw, Trash2 } from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import { XtermCanvas } from "@/components/terminal/XtermCanvas";
import { restartTerminalSession } from "@/lib/api/terminal";

interface TerminalTabViewProps {
  sessionId: string;
}

export function TerminalTabView({ sessionId }: TerminalTabViewProps) {
  const [status, setStatus] = useState<"connected" | "connecting" | "disconnected">("connecting");
  const termInstanceRef = useRef<Terminal | null>(null);

  const handleStatusChange = useCallback(
    (st: "connected" | "connecting" | "disconnected") => {
      setStatus(st);
    },
    []
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
      await restartTerminalSession(sessionId);
      if (termInstanceRef.current) {
        termInstanceRef.current.clear();
      }
    } catch (err) {
      console.error("重启终端失败:", err);
    }
  };

  return (
    <div className="flex flex-col w-full h-full bg-[#141416] text-[#ECECED]">
      {/* 终端控制顶栏 */}
      <div className="h-9 px-3 bg-[#18181A] border-b border-[#26262A] flex items-center justify-between shrink-0 text-xs">
        <div className="flex items-center gap-2">
          <TerminalIcon className="w-3.5 h-3.5 text-emerald-400" />
          <span className="font-mono text-[11px] text-[#A1A1AA]">
            session: {sessionId}
          </span>
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              status === "connected"
                ? "bg-emerald-400"
                : status === "connecting"
                ? "bg-amber-400 animate-pulse"
                : "bg-rose-400"
            }`}
            title={status}
          />
        </div>

        <div className="flex items-center gap-1 text-[#8E8E93]">
          <button
            type="button"
            onClick={handleClear}
            className="p-1 rounded hover:text-white hover:bg-white/10 transition-colors"
            title="清屏"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleRestart}
            className="p-1 rounded hover:text-white hover:bg-white/10 transition-colors"
            title="重启终端会话"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 终端舞台 */}
      <div className="flex-1 w-full min-h-0 relative bg-[#121214] p-1">
        <XtermCanvas
          sessionId={sessionId}
          isVisible={true}
          onStatusChange={handleStatusChange}
          onRegisterTerm={handleRegisterTerm}
        />
      </div>
    </div>
  );
}
