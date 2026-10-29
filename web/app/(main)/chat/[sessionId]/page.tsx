import { SessionChatClient } from "./SessionChatClient";

export function generateStaticParams() {
  return [{ sessionId: "default" }];
}

export default function SessionChatPage({
  params,
}: {
  params: { sessionId: string };
}) {
  return <SessionChatClient sessionId={params.sessionId} />;
}

