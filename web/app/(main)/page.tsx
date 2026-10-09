"use client";

import React from "react";
import { useSessionStore } from "@/stores/useSessionStore";
import { MessageContainer } from "@/components/chat/MessageContainer";

export default function MainPage() {
  const { activeSessionId } = useSessionStore();

  return <MessageContainer sessionId={activeSessionId} />;
}
