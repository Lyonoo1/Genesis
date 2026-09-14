import React from "react";

export default function SessionChatPage({
  params,
}: {
  params: { sessionId: string };
}) {
  return (
    <div className="space-y-4">
      <div className="p-4 rounded-lg border border-hairline bg-surface-sidebar">
        <span className="text-xs font-mono text-accent-cyan">
          Session ID: {params.sessionId}
        </span>
        <p className="mt-2 text-sm text-genesis-secondary">
          当前会话就绪。后续 FE-Step 3 将在此装配 MessageList、MessageBubble 与流式打字机渲染器。
        </p>
      </div>
    </div>
  );
}
