export type ConfirmStyle =
  | "auto"
  | "google_aistudio"
  | "claude_desktop"
  | "codex_desktop";

export type ConcreteConfirmStyle = Exclude<ConfirmStyle, "auto">;

export type PermissionMode = "accept_edits" | "default" | "review_all";

export type SelectionMode = "single" | "multi" | "approval" | "form";

export type ConfirmationKind =
  | "clarification"
  | "tool_approval"
  | "parameter_form"
  | "plan_approval"
  | "batch_approval";

export type PermissionScope = "once" | "session" | "workspace_rule";

export interface BatchItemDecision {
  decision: "approved" | "rejected";
  permission_scope?: PermissionScope;
  scope_signature?: string;
}

export interface WorkspacePermissionRule {
  id: string;
  user_id: string;
  workspace_key: string;
  workspace_label?: string | null;
  scope_signature: string;
  created_from_session?: string | null;
  created_at: string;
  last_used_at?: string | null;
}

/** 仅确认环节自身状态；IDLE/STREAMING/COMPLETED 由现有 AgentLifecycleState 承担 */
export type ConfirmationStatus = "AWAITING" | "SUBMITTING" | "RESOLVED";

export interface ConfirmationOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface FormFieldSchema {
  key: string;
  label: string;
  description?: string;
  type: "text" | "number" | "select" | "boolean" | "json";
  required?: boolean;
  placeholder?: string;
  default_value?: unknown;
  options?: { label: string; value: string }[];
  pattern?: string; // text
  min?: number; // number
  max?: number; // number
}

export interface CodePreviewPayload {
  language: "bash" | "diff" | "json" | "markdown";
  filename?: string;
  content: string;
}

export interface ConfirmationItem {
  item_id: string;
  tool_call_id?: string; // tool_approval 必填（item 级，为 batch 预留）
  title: string;
  review_title?: string; // Charcoal 审阅副标题
  subtitle?: string; // 如后端 perm_reason
  selection_mode: SelectionMode;
  auto_advance?: boolean; // 仅 single 有效，默认 true
  risk_level?: "low" | "medium" | "high";
  tool_name?: string;
  diff_stat?: string; // "+6 -2"
  scope_signature?: string | null; // null => 不允许会话级放行，隐藏 Always allow
  code_preview?: CodePreviewPayload;
  options?: ConfirmationOption[];
  custom_input?: {
    enabled: boolean;
    mode: "override" | "append";
    placeholder?: string;
  };
  form_fields?: FormFieldSchema[];
}

/** SSE: confirmation_required */
export interface ConfirmationRequestEvent {
  request_id: string;
  session_id: string;
  agent_id?: string | null;
  kind: ConfirmationKind;
  ui_hint?: ConcreteConfirmStyle;
  dismissible: boolean;
  allow_chat_override: boolean;
  timeout_ms?: number;
  expires_at?: string;
  items: ConfirmationItem[];
}

/** SSE: confirmation_resolved */
export interface ConfirmationResolvedEvent {
  request_id: string;
  decision: Decision;
}

export type ToolDecision =
  | "approved"
  | "rejected"
  | "dismissed"
  | "superseded_by_message"
  | "timeout";

export type ClarifyDecision =
  | "submitted"
  | "skipped_all"
  | "dismissed"
  | "superseded_by_message"
  | "timeout";

export type Decision = ToolDecision | ClarifyDecision;

export interface ItemAnswer {
  status: "answered" | "skipped";
  selected_ids: string[];
  custom_text?: string;
  custom_mode?: "override" | "append";
  form_values?: Record<string, unknown>;
}

/** 上行：tool_approval 只看 decision + permission_scope；batch_approval 逐项携带 item_decisions；plan_approval 走 submitPlanDecision；answers 仅 clarification/form 使用 */
export type ConfirmationResponsePayload =
  | {
      request_id: string;
      kind: "tool_approval";
      decision: ToolDecision;
      permission_scope?: PermissionScope;
      scope_signature?: string; // permission_scope='session' | 'workspace_rule' 时回带，后端二次校验与下发值一致
      active_style: ConcreteConfirmStyle;
    }
  | {
      request_id: string;
      kind: "batch_approval";
      decision: "submitted" | "dismissed" | "superseded_by_message" | "timeout";
      item_decisions: Record<string, BatchItemDecision>;
      active_style: ConcreteConfirmStyle;
    }
  | {
      request_id: string;
      kind: "plan_approval";
      decision: ToolDecision;
      feedback?: string;
      active_style: ConcreteConfirmStyle;
    }
  | {
      request_id: string;
      kind: "clarification" | "parameter_form";
      decision: ClarifyDecision;
      answers: Record<string, ItemAnswer>;
      active_style: ConcreteConfirmStyle;
    };

export interface DraftItemAnswer extends ItemAnswer {
  touched: boolean;
}

export interface DraftState {
  activeIndex: number;
  focusedOptionIndex: number;
  /** 记录当前聚焦输入框标识（'writein' | `field:${key}`），风格热切换后还原焦点 */
  focusedField: string | null;
  answers: Record<string, DraftItemAnswer>;
  formErrors: Record<string, Record<string, string>>;
  codeExpanded: boolean;
  /** 是否处于最小化紧凑条状态（不关闭/不拒绝，方便浏览上方聊天记录） */
  minimized?: boolean;
  /** P2-4 批量审批每条目的本地决议草稿（热切换风格与刷新均保留） */
  batchDecisions?: Record<string, BatchItemDecision>;
}

export interface ConfirmationQueueEntry {
  request: ConfirmationRequestEvent;
  draft: DraftState;
  status: ConfirmationStatus;
  resolvedDecision?: Decision;
  receivedAt: number;
}
