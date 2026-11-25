export type SSEEventType =
  | "session_info"
  | "session_title_updated"
  | "tool_start"
  | "tool_call_start"
  | "tool_call_delta"
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
  | "state_transition"
  | "plan_proposed"
  | "preempted"
  | "context_telemetry"
  | "pty_output"
  | "terminal_output"
  | "done"
  | "permission_request"
  | "confirmation_required"
  | "confirmation_resolved"
  | "error";

export interface SessionInfoPayload {
  session_id: string;
  model: string;
  mode?: "plan" | "act";
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
  delta?: string;
  text?: string;
  step?: number;
}

export interface TextDeltaPayload {
  delta?: string;
  text?: string;
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
  patch_id?: string;
  snapshot_id?: string;
}

export interface WorkbenchTodosPayload {
  session_id: string;
  todos: Array<{ id: string; content: string; status: "pending" | "in_progress" | "completed" }>;
  step?: number;
}

export interface SubagentProgressPayload {
  event?: string;
  agent_id?: string;
  agent_type?: string;
  mode?: string;
  write_scope?: string[];
  task_prompt?: string;
  step?: number;
  max_steps?: number;
  status: string;
  tool_calls?: string[];
  summary_preview?: string;
  thinking?: string;
  thinking_content?: string;
  thinking_delta?: string;
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
  | { event: "tool_call_delta"; data: Record<string, unknown> }
  | { event: "tool_result"; data: ToolResultPayload }
  | { event: "tool_call_result"; data: ToolResultPayload }
  | { event: "permission_request"; data: PermissionRequestPayload }
  | { event: "confirmation_required"; data: Record<string, unknown> }
  | { event: "confirmation_resolved"; data: Record<string, unknown> }
  | { event: "reasoning_delta"; data: ReasoningDeltaPayload }
  | { event: "text_delta"; data: TextDeltaPayload }
  | { event: "step_finish"; data: Record<string, unknown> }
  | { event: "usage"; data: UsagePayload }
  | { event: "workbench_preview"; data: WorkbenchPreviewPayload }
  | { event: "workbench_file_change"; data: WorkbenchFileChangePayload }
  | { event: "workbench_todos"; data: WorkbenchTodosPayload }
  | { event: "subagent_progress"; data: SubagentProgressPayload }
  | { event: "mid_task_steered"; data: MidTaskSteeredPayload }
  | { event: "state_transition"; data: Record<string, unknown> }
  | { event: "plan_proposed"; data: Record<string, unknown> }
  | { event: "preempted"; data: Record<string, unknown> }
  | { event: "context_telemetry"; data: Record<string, unknown> }
  | { event: "pty_output"; data: Record<string, unknown> }
  | { event: "terminal_output"; data: Record<string, unknown> }
  | { event: "done"; data: Record<string, unknown> }
  | { event: "error"; data: ErrorPayload }
  | { event: string; data: unknown };

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
        let hasEvent = false;
        let hasData = false;
        let rawData = "";

        const lines = block.split("\n");
        for (const line of lines) {
          if (line.startsWith(":")) continue; // 忽略 SSE 注释心跳（如 : ping）
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim() as SSEEventType;
            hasEvent = true;
          } else if (line.startsWith("data:")) {
            rawData = line.slice(5).trim();
            hasData = true;
          }
        }

        if (!hasEvent && !hasData) continue;

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

export interface ReadSSEOptions {
  signal?: AbortSignal;
  onEvent: (event: string, data: unknown) => void;
}

/**
 * 通用 GET SSE 长连接读取器：自动拼接 basePath/API Base 与 Bearer Token，复用 parseSSEStream。
 */
export async function readSSE(
  endpoint: string,
  options: ReadSSEOptions
): Promise<void> {
  const { getApiBaseUrl, getAuthToken } = await import("./client");
  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  const token = getAuthToken();

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: options.signal,
  });

  if (!res.ok) {
    throw new Error(`SSE 连接失败 (${res.status})`);
  }
  if (!res.body) {
    throw new Error("SSE 响应体为空");
  }

  await parseSSEStream(
    res.body.getReader(),
    (msg) => {
      options.onEvent(msg.event, msg.data);
    },
    options.signal
  );
}
