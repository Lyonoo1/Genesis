export type SSEEventType =
  | "session_info"
  | "session_title_updated"
  | "tool_start"
  | "tool_call_start"
  | "tool_result"
  | "tool_call_result"
  | "reasoning_delta"
  | "text_delta"
  | "step_finish"
  | "usage"
  | "done"
  | "error";

export interface SessionInfoPayload {
  session_id: string;
  model: string;
}

export interface SessionTitleUpdatedPayload {
  session_id: string;
  title: string;
}

export interface ToolStartPayload {
  tool_call_id: string;
  name: string;
  args?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
}

export interface ToolResultPayload {
  tool_call_id: string;
  output?: unknown;
  result?: unknown;
  latency_ms?: number;
  is_error?: boolean;
}

export interface ReasoningDeltaPayload {
  delta: string;
  step?: number;
}

export interface TextDeltaPayload {
  delta: string;
  step?: number;
}

export interface UsagePayload {
  latency_ms?: number;
  tokens?: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export type SSEEventCallback =
  | { event: "session_info"; data: SessionInfoPayload }
  | { event: "session_title_updated"; data: SessionTitleUpdatedPayload }
  | { event: "tool_start"; data: ToolStartPayload }
  | { event: "tool_call_start"; data: ToolStartPayload }
  | { event: "tool_result"; data: ToolResultPayload }
  | { event: "tool_call_result"; data: ToolResultPayload }
  | { event: "reasoning_delta"; data: ReasoningDeltaPayload }
  | { event: "text_delta"; data: TextDeltaPayload }
  | { event: "step_finish"; data: Record<string, unknown> }
  | { event: "usage"; data: UsagePayload }
  | { event: "done"; data: Record<string, unknown> }
  | { event: "error"; data: ErrorPayload };

export type SSEEventHandler = (msg: SSEEventCallback) => void;

/**
 * 生产级 SSE 流解析器：处理 TCP 分包/粘包与事件解析
 */
export async function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: SSEEventHandler,
  signal?: AbortSignal
): Promise<void> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 以双换行分割 SSE message block
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        if (!block.trim()) continue;

        let currentEvent: SSEEventType = "text_delta";
        let rawData = "";

        const lines = block.split("\n");
        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim() as SSEEventType;
          } else if (line.startsWith("data:")) {
            rawData = line.slice(5).trim();
          }
        }

        let parsedData: unknown = rawData;
        if (rawData) {
          try {
            parsedData = JSON.parse(rawData);
          } catch {
            parsedData = rawData;
          }
        } else if (currentEvent === "done") {
          parsedData = {};
        }

        onEvent({
          event: currentEvent,
          data: parsedData,
        } as SSEEventCallback);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
