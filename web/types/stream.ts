/**
 * 全局流式信封契约与双模态状态机类型定义 (Batch 1)
 * 严格对齐后端 /api/models/schemas/stream_envelope.py
 */

export const StreamChannel = {
  CHAT: "chat",
  WORKBENCH_DIFF: "workbench_diff",
  WORKBENCH_PTY: "workbench_pty",
  PLAN_STATE: "plan_state",
  CONTEXT_TELEMETRY: "context_telemetry",
} as const;

export type StreamChannel = (typeof StreamChannel)[keyof typeof StreamChannel];

export const AgentRunMode = {
  PLAN: "plan",
  ACT: "act",
} as const;

export type AgentRunMode = (typeof AgentRunMode)[keyof typeof AgentRunMode];

export const AgentLifecycleState = {
  IDLE: "IDLE",
  PLANNING: "PLANNING",
  AWAITING_PLAN_APPROVAL: "AWAITING_PLAN_APPROVAL",
  COMPILING_CONTEXT: "COMPILING_CONTEXT",
  STREAMING_LLM: "STREAMING_LLM",
  EXECUTING_TOOLS: "EXECUTING_TOOLS",
  EVALUATING: "EVALUATING",
  INTERRUPTED: "INTERRUPTED",
  COMPLETED: "COMPLETED",
} as const;

export type AgentLifecycleState =
  (typeof AgentLifecycleState)[keyof typeof AgentLifecycleState];

export type StreamEventName =
  | "session_info"
  | "text_delta"
  | "reasoning_delta"
  | "tool_call_start"
  | "tool_call_delta"
  | "tool_call_result"
  | "step_finish"
  | "session_title_updated"
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
  | "permission_request"
  | "confirmation_required"
  | "confirmation_resolved"
  | "done"
  | "error";

// ============================================================================
// 各 Channel 细分 Payload 接口定义
// ============================================================================

/** Channel: chat */
export interface ChatDeltaPayload {
  delta?: string;
  text?: string;
  step?: number;
  agent_id?: string;
}

export interface ChatToolCallStartPayload {
  tool_call_id: string;
  name: string;
  args?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  step?: number;
  agent_id?: string;
}

export interface ChatToolCallDeltaPayload {
  tool_call_id: string;
  delta: string;
  step?: number;
}

export interface ChatToolCallResultPayload {
  tool_call_id: string;
  agent_id?: string;
  name: string;
  result: unknown;
  output?: unknown;
  diff?: string | null;
  additions?: number | null;
  deletions?: number | null;
  is_error: boolean;
  step?: number;
  latency_ms?: number;
}

export interface ChatPreemptedPayload {
  session_id: string;
  step: number;
  partial_text?: string;
  partial_stdout?: string;
  steered_content?: string;
  recovery_anchor: string;
}

/** Channel: workbench_diff */
export interface WorkbenchDiffPayload {
  path: string;
  name?: string;
  unified_diff: string;
  diff: string;
  additions: number;
  deletions: number;
  original_content?: string;
  modified_content?: string;
  patch_id?: string;
  snapshot_id?: string;
}

/** Channel: workbench_pty */
export interface WorkbenchPtyPayload {
  session_id: string;
  pty_session_id?: string;
  chunk?: string;
  output?: string;
  is_interactive?: boolean;
  status?: "RUNNING" | "RUNNING_INTERACTIVE" | "EXITED";
  exit_code?: number | null;
}

/** Channel: plan_state */
export interface StateTransitionPayload {
  from_state: AgentLifecycleState;
  to_state: AgentLifecycleState;
  reason?: string;
  mode: AgentRunMode;
  step?: number;
}

export interface PlanProposedPayload {
  session_id: string;
  plan_id: string;
  plan: string;
  step?: number;
  state: AgentLifecycleState;
}

/** Channel: context_telemetry */
export interface ContextTelemetryPayload {
  session_id: string;
  total_tokens: number;
  context_window?: number;
  frozen_prefix_tokens?: number;
  history_tokens?: number;
  working_memory_tokens?: number;
  folded_stubs_count?: number;
  stubbed_turns_count?: number;
  dirty_files?: string[];
  dirty_files_count?: number;
  estimated_cache_hit_ratio?: number;
  prefix_cache_stable: boolean;
}

export type ChannelPayloadMap = {
  [StreamChannel.CHAT]:
    | ChatDeltaPayload
    | ChatToolCallStartPayload
    | ChatToolCallDeltaPayload
    | ChatToolCallResultPayload
    | ChatPreemptedPayload
    | Record<string, unknown>;
  [StreamChannel.WORKBENCH_DIFF]: WorkbenchDiffPayload;
  [StreamChannel.WORKBENCH_PTY]: WorkbenchPtyPayload;
  [StreamChannel.PLAN_STATE]: StateTransitionPayload | PlanProposedPayload;
  [StreamChannel.CONTEXT_TELEMETRY]: ContextTelemetryPayload;
};

/**
 * 泛型流式信封接口：既包含标准信封元数据，又支持顶层平铺兼容字段
 */
export interface StreamEnvelope<T = Record<string, unknown>> {
  seq: number;
  turn_id: string;
  agent_id: string;
  parent_call_id?: string | null;
  channel: StreamChannel;
  event: StreamEventName | string;
  payload: T;
  timestamp: number;
  [key: string]: unknown;
}

export function isStreamEnvelope(
  data: unknown
): data is StreamEnvelope<Record<string, unknown>> {
  if (!data || typeof data !== "object") {
    return false;
  }
  const candidate = data as Record<string, unknown>;
  return (
    typeof candidate.seq === "number" &&
    typeof candidate.turn_id === "string" &&
    typeof candidate.channel === "string" &&
    typeof candidate.event === "string" &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null
  );
}
