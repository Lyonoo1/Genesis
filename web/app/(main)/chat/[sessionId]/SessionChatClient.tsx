"use client";

import React, { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { useSessionStore } from "@/stores/useSessionStore";
import { useChatStore } from "@/stores/useChatStore";
import { MessageContainer } from "@/components/chat/MessageContainer";

export function SessionChatClient({ sessionId: initialSessionId }: { sessionId: string }) {
  const pathname = usePathname();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const lastSwitchedIdRef = React.useRef<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // 关键：在静态导出（output: 'export'）模式下，Next.js 生成的 default.html 会将 initialSessionId 硬编码为 "default"。
  // 必须优先从实际浏览器 URL（如 /chat/cbde9098-...）提取真实会话 ID。
  const targetSessionId = useMemo(() => {
    if (typeof window !== "undefined") {
      const match = window.location.pathname.match(/\/chat\/([^/?#]+)/);
      if (match && match[1] && match[1] !== "default") {
        return match[1];
      }
    }
    const pathMatch = pathname?.match(/\/chat\/([^/?#]+)/);
    if (pathMatch && pathMatch[1] && pathMatch[1] !== "default") {
      return pathMatch[1];
    }
    if (initialSessionId && initialSessionId !== "default") {
      return initialSessionId;
    }
    return activeSessionId || null;
  }, [pathname, initialSessionId, activeSessionId, mounted]);

  useEffect(() => {
    if (targetSessionId && lastSwitchedIdRef.current !== targetSessionId) {
      lastSwitchedIdRef.current = targetSessionId;
      setActiveSessionId(targetSessionId);
      switchSession(targetSessionId);
    }
  }, [targetSessionId, setActiveSessionId, switchSession]);

  return <MessageContainer sessionId={targetSessionId} />;
}
