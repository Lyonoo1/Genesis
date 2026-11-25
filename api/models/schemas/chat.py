from enum import Enum
from typing import Any, Optional
from uuid import UUID
from pydantic import BaseModel, Field


class SSEEventName(str, Enum):
    """SSE 流式事件名枚举契约"""

    TEXT_DELTA = "text_delta"
    REASONING_DELTA = "reasoning_delta"
    TOOL_CALL_START = "tool_call_start"
    TOOL_CALL_DELTA = "tool_call_delta"
    TOOL_CALL_RESULT = "tool_call_result"
    STEP_FINISH = "step_finish"
    SESSION_TITLE_UPDATED = "session_title_updated"
    WORKBENCH_PREVIEW = "workbench_preview"
    WORKBENCH_FILE_CHANGE = "workbench_file_change"
    WORKBENCH_TODOS = "workbench_todos"
    SUBAGENT_PROGRESS = "subagent_progress"
    MID_TASK_STEERED = "mid_task_steered"
    STATE_TRANSITION = "state_transition"
    PLAN_PROPOSED = "plan_proposed"
    PREEMPTED = "preempted"
    CONTEXT_TELEMETRY = "context_telemetry"
    PTY_OUTPUT = "pty_output"
    SYSTEM_NOTICE = "system_notice"
    CONFIRMATION_REQUIRED = "confirmation_required"
    CONFIRMATION_RESOLVED = "confirmation_resolved"
    CONFIRMATION_SNAPSHOT = "confirmation_snapshot"
    GRANTS_CHANGED = "grants_changed"
    DONE = "done"
    ERROR = "error"


class SteeringRequest(BaseModel):
    """运行中实时插话入参"""

    content: str = Field(..., min_length=1, description="用户插话指令内容")
    preempt: bool = Field(
        default=True, description="是否微秒级抢占中断当前正在执行的流或慢工具"
    )


class ChatRequest(BaseModel):
    """发送消息与触发 ReAct 循环入参"""

    content: str = Field(..., min_length=1, description="用户提问或指令文本")
    parent_id: Optional[Any] = Field(
        default=None, description="父消息节点 ID，用于编辑重发分支修剪"
    )
    skill_id: Optional[str] = Field(
        default=None, description="直接指定的触发 Skill 唯一标识或 ID"
    )
    model: str = Field(default="gpt-4o", description="指定推理大模型")
    reasoning_effort: Optional[str] = Field(
        default="medium", description="思考深度 (low / medium / high)"
    )
    temperature: Optional[float] = Field(
        default=0.7, ge=0.0, le=2.0, description="生成发散度"
    )
    max_tokens: Optional[int] = Field(
        default=None, description="单步最大 Token 限制 (可选，为空时由系统自动自适应)"
    )
    context_window: Optional[int] = Field(
        default=None, description="模型最大上下文容量 (为空时按模型自动推断真实窗口)"
    )
    api_key: Optional[str] = Field(
        default=None, description="自定义模型 API Key (用于用户自带密钥动态调用)"
    )
    base_url: Optional[str] = Field(
        default=None, description="自定义模型 API Base URL"
    )
    provider: Optional[str] = Field(
        default=None, description="自定义模型提供商协议 (openai | anthropic)"
    )
    workspace_path: Optional[str] = Field(
        default=None, description="当前项目工作区根目录绝对路径 (可选，若为空则由系统自动探测项目目录)"
    )
    mode: Optional[str] = Field(
        default="act", description="运行模式: plan | act"
    )
    approved_plan_id: Optional[str] = None
    permission_mode: Optional[str] = Field(
        default="accept_edits",
        description="权限审批触发粒度: accept_edits | default | review_all",
    )
    allow_ask_user: bool = Field(
        default=True,
        description="是否允许 Agent 在必要时主动发起澄清提问 (agent__ask_user)",
    )


class ChatStopResponse(BaseModel):
    """停止生成响应体"""

    success: bool
    message: str


class ConnectionTestRequest(BaseModel):
    """测试模型 API 连通性入参"""

    provider: str = Field(default="openai", description="openai | anthropic")
    base_url: str = Field(..., description="API Base URL")
    api_key: str = Field(..., description="API Key")
    model: str = Field(default="gpt-4o", description="测试模型名")


class ConnectionTestResponse(BaseModel):
    """测试模型 API 连通性响应"""

    success: bool
    latency_ms: Optional[int] = None
    error: Optional[str] = None
