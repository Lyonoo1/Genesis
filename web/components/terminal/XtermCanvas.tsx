"use client";

import React, { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { getTerminalWsUrl } from "@/lib/api/terminal";

interface XtermCanvasProps {
  sessionId: string;
  isVisible: boolean;
  onStatusChange?: (
    status: "connected" | "connecting" | "disconnected"
  ) => void;
  onRegisterTerm?: (term: Terminal | null) => void;
}

export function XtermCanvas({
  sessionId,
  isVisible,
  onStatusChange,
  onRegisterTerm,
}: XtermCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // 使用 ref 保存回调引用，绝对避免将它们作为 useEffect 依赖项引起销毁与重建的死循环
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const onRegisterTermRef = useRef(onRegisterTerm);
  onRegisterTermRef.current = onRegisterTerm;

  useEffect(() => {
    let isDisposed = false;
    let pingTimer: NodeJS.Timeout | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let resizeObserver: ResizeObserver | null = null;

    async function initTerminal() {
      if (!containerRef.current || isDisposed) return;

      // 动态载入 xterm 与 fit-addon，防止 SSR 阶段访问 window/document
      const { Terminal: XTerm } = await import("@xterm/xterm");
      const { FitAddon: XFitAddon } = await import("@xterm/addon-fit");

      if (isDisposed || !containerRef.current) return;

      // 清空旧 DOM
      containerRef.current.innerHTML = "";

      const term = new XTerm({
        cursorBlink: true,
        cursorStyle: "bar",
        fontFamily:
          "'JetBrains Mono', 'Geist Mono', SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.35,
        letterSpacing: 0,
        scrollback: 5000,
        theme: {
          background: "#121214",
          foreground: "#ECECED",
          cursor: "#10B981",
          cursorAccent: "#121214",
          selectionBackground: "rgba(59, 130, 246, 0.35)",
          black: "#1A1A1E",
          red: "#EF4444",
          green: "#10B981",
          yellow: "#F59E0B",
          blue: "#3B82F6",
          magenta: "#EC4899",
          cyan: "#06B6D4",
          white: "#F4F4F5",
          brightBlack: "#52525B",
          brightRed: "#F87171",
          brightGreen: "#34D399",
          brightYellow: "#FBBF24",
          brightBlue: "#60A5FA",
          brightMagenta: "#F472B6",
          brightCyan: "#22D3EE",
          brightWhite: "#FFFFFF",
        },
        convertEol: true,
        allowTransparency: true,
      });

      const fitAddon = new XFitAddon();
      term.loadAddon(fitAddon);

      // 自定义按键分流：放行终端切换快捷键与选区文本复制
      term.attachCustomKeyEventHandler((e) => {
        if (
          (e.metaKey || e.ctrlKey) &&
          (e.key === "`" || e.code === "Backquote")
        ) {
          return false;
        }
        if (
          (e.metaKey || e.ctrlKey) &&
          (e.key === "c" || e.key === "C") &&
          term.hasSelection()
        ) {
          return false;
        }
        return true;
      });

      term.open(containerRef.current);
      termRef.current = term;
      fitAddonRef.current = fitAddon;
      onRegisterTermRef.current?.(term);

      // 初次适配大小
      try {
        fitAddon.fit();
      } catch {}

      // 使用 ResizeObserver 监听容器尺寸变化，毫秒级响应抽屉收展与拉伸
      resizeObserver = new ResizeObserver(() => {
        if (!isDisposed && termRef.current && fitAddonRef.current) {
          try {
            fitAddonRef.current.fit();
          } catch {}
        }
      });
      resizeObserver.observe(containerRef.current);

      let reconnectAttempts = 0;
      let childExited = false;

      function connectWs() {
        if (isDisposed) return;
        onStatusChangeRef.current?.("connecting");
        const wsUrl = getTerminalWsUrl(sessionId);
        const rows = term.rows || 24;
        const cols = term.cols || 80;

        const ws = new WebSocket(`${wsUrl}?rows=${rows}&cols=${cols}`);
        wsRef.current = ws;

        ws.onopen = () => {
          if (isDisposed) return;
          reconnectAttempts = 0;
          onStatusChangeRef.current?.("connected");

          // 连接建立后同步一次最新尺寸
          if (termRef.current && fitAddonRef.current) {
            try {
              fitAddonRef.current.fit();
              ws.send(
                JSON.stringify({
                  type: "resize",
                  rows: termRef.current.rows,
                  cols: termRef.current.cols,
                })
              );
            } catch {}
          }

          if (pingTimer) clearInterval(pingTimer);
          pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ping" }));
            }
          }, 25000);
        };

        ws.onmessage = (event) => {
          if (isDisposed) return;
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "output" && typeof msg.data === "string") {
              term.write(msg.data);
            } else if (msg.type === "exit") {
              childExited = true;
              term.writeln(
                `\r\n\x1b[33m[子进程已退出，退出码: ${msg.code}]\x1b[0m\r\n`
              );
              onStatusChangeRef.current?.("disconnected");
            }
          } catch {
            term.write(event.data);
          }
        };

        ws.onclose = () => {
          if (isDisposed) return;
          if (pingTimer) clearInterval(pingTimer);
          onStatusChangeRef.current?.("disconnected");

          // 若非子进程正常退出且未超过重试上限，尝试自动指数退避重连
          if (!childExited && reconnectAttempts < 5) {
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 8000);
            reconnectAttempts += 1;
            reconnectTimer = setTimeout(() => {
              if (!isDisposed) connectWs();
            }, delay);
          }
        };

        ws.onerror = () => {
          if (isDisposed) return;
          onStatusChangeRef.current?.("disconnected");
        };
      }

      connectWs();

      // 监听用户键盘输入
      term.onData((data) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "input", data }));
        }
      });

      // 监听终端行/列大小变化并上报给后端 PTY (TIOCSWINSZ)
      term.onResize(({ cols: newCols, rows: newRows }) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: "resize",
              cols: newCols,
              rows: newRows,
            })
          );
        }
      });
    }

    initTerminal();

    return () => {
      isDisposed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (resizeObserver) resizeObserver.disconnect();
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
        wsRef.current = null;
      }
      if (termRef.current) {
        try {
          termRef.current.dispose();
        } catch {}
        termRef.current = null;
        onRegisterTermRef.current?.(null);
      }
      if (fitAddonRef.current) {
        try {
          fitAddonRef.current.dispose();
        } catch {}
        fitAddonRef.current = null;
      }
    };
  }, [sessionId]);

  // 当面板可见性发生变化时触发重新自适应
  useEffect(() => {
    if (isVisible && fitAddonRef.current) {
      const raf = requestAnimationFrame(() => {
        try {
          fitAddonRef.current?.fit();
          if (termRef.current) {
            termRef.current.focus();
          }
        } catch {}
      });
      const timer = setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
        } catch {}
      }, 80);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(timer);
      };
    }
  }, [isVisible]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full p-2 bg-[#121214] overflow-hidden select-text"
      style={{ minHeight: "100px" }}
    />
  );
}
