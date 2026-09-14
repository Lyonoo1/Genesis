from datetime import datetime
from enum import Enum
from typing import Any, Optional
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field


class MessageRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"
    SYSTEM = "system"


class MessageStatus(str, Enum):
    SENDING = "sending"
    STREAMING = "streaming"
    SUCCESS = "success"
    FAILED = "failed"


class ToolCallItem(BaseModel):
    """单次 Tool Calling 结构"""

    id: str = Field(..., description="调用唯一标识")
    name: str = Field(..., description="工具名称，如 mcp__fetch__url")
    args: dict[str, Any] = Field(default_factory=dict, description="执行参数字典")


class MessageCreate(BaseModel):
    """创建持久化消息入参"""

    session_id: UUID
    role: MessageRole
    content: Optional[str] = None
    parent_id: Optional[UUID] = None
    raw_tool_calls: Optional[list[ToolCallItem]] = None
    tool_call_id: Optional[str] = None
    active_skill_id: Optional[UUID] = None
    status: MessageStatus = MessageStatus.SUCCESS


class MessageResponse(BaseModel):
    """消息统一输出体"""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    session_id: UUID
    parent_id: Optional[UUID] = None
    role: str
    content: Optional[str] = None
    raw_tool_calls: Optional[list[dict[str, Any]]] = None
    tool_call_id: Optional[str] = None
    active_skill_id: Optional[UUID] = None
    status: str
    created_at: datetime


class MessageListResponse(BaseModel):
    """游标分页消息列表响应体"""

    items: list[MessageResponse]
    next_cursor: Optional[str] = Field(
        default=None,
        description="下一页请求游标 (ISO 8601 时间戳字符串)",
    )
    has_more: bool = Field(default=False, description="是否还有更多历史消息")
