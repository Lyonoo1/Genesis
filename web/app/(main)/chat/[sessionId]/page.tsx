"use client";

import React, { useEffect } from "react";
import { useSessionStore } from "@/stores/useSessionStore";
import { useChatStore } from "@/stores/useChatStore";
import { MessageContainer } from "@/components/chat/MessageContainer";

export default function SessionChatPage({
  params,
}: {
  params: { sessionId: string };
}) {
  const setActiveSessionId = useSessionStore((s) => s.setActiveSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const lastSwitchedIdRef = React.useRef<string | null>(null);

  useEffect(() => {
    if (params.sessionId && lastSwitchedIdRef.current !== params.sessionId) {
      lastSwitchedIdRef.current = params.sessionId;
      setActiveSessionId(params.sessionId);
      switchSession(params.sessionId);
    }
  }, [params.sessionId, setActiveSessionId, switchSession]);

  return <MessageContainer sessionId={params.sessionId} />;
}
