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
  const { setActiveSessionId } = useSessionStore();
  const { switchSession } = useChatStore();

  useEffect(() => {
    if (params.sessionId) {
      setActiveSessionId(params.sessionId);
      switchSession(params.sessionId);
    }
  }, [params.sessionId, setActiveSessionId, switchSession]);

  return <MessageContainer sessionId={params.sessionId} />;
}
