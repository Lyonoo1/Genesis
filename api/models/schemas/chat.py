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
    DONE = "done"
    ERROR = "error"


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
        default=1048576, description="模型最大上下文容量 (默认 1M: 1048576)"
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

