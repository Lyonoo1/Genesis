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
  | "workbench_preview"
  | "workbench_file_change"
  | "workbench_todos"
  | "subagent_progress"
  | "mid_task_steered"
  | "done"
  | "permission_request"
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
  agent_id?: string;
  name?: string;
  output?: unknown;
  result?: unknown;
  latency_ms?: number;
  is_error?: boolean;
}

export interface PermissionRequestPayload {
  approval_id?: string;
  session_id?: string;
  tool_name?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  args?: Record<string, unknown>;
  reason?: string;
  tool_call_id?: string;
  step?: number;
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

export interface WorkbenchPreviewPayload {
  url: string;
  port?: number | null;
}

export interface WorkbenchFileChangePayload {
  path: string;
  name?: string;
  unified_diff?: string;
  diff?: string;
  additions?: number;
  deletions?: number;
  original_content?: string;
  modified_content?: string;
}

export interface WorkbenchTodosPayload {
  session_id: string;
  todos: Array<{ id: string; content: string; status: "pending" | "in_progress" | "completed" }>;
  step?: number;
}

export interface SubagentProgressPayload {
  event: string;
  agent_id?: string;
  agent_type: string;
  task_prompt?: string;
  step?: number;
  max_steps?: number;
  status: string;
  tool_calls?: string[];
  summary_preview?: string;
  thinking?: string;
  thinking_content?: string;
}

export interface MidTaskSteeredPayload {
  session_id: string;
  content: string;
  step?: number;
}

export type SSEEventCallback =
  | { event: "session_info"; data: SessionInfoPayload }
  | { event: "session_title_updated"; data: SessionTitleUpdatedPayload }
  | { event: "tool_start"; data: ToolStartPayload }
  | { event: "tool_call_start"; data: ToolStartPayload }
  | { event: "tool_result"; data: ToolResultPayload }
  | { event: "tool_call_result"; data: ToolResultPayload }
  | { event: "permission_request"; data: PermissionRequestPayload }
  | { event: "reasoning_delta"; data: ReasoningDeltaPayload }
  | { event: "text_delta"; data: TextDeltaPayload }
  | { event: "step_finish"; data: Record<string, unknown> }
  | { event: "usage"; data: UsagePayload }
  | { event: "workbench_preview"; data: WorkbenchPreviewPayload }
  | { event: "workbench_file_change"; data: WorkbenchFileChangePayload }
  | { event: "workbench_todos"; data: WorkbenchTodosPayload }
  | { event: "subagent_progress"; data: SubagentProgressPayload }
  | { event: "mid_task_steered"; data: MidTaskSteeredPayload }
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
