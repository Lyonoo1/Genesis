from datetime import datetime
from typing import Optional
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field


class SessionCreate(BaseModel):
    """创建会话入参"""

    title: Optional[str] = Field(
        default="新对话",
        max_length=100,
        description="会话标题",
        examples=["Genesis 架构设计讨论"],
    )


class SessionUpdate(BaseModel):
    """更新会话入参（重命名/置顶）"""

    title: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=100,
        description="新标题",
        examples=["生产部署规范审查"],
    )
    pinned: Optional[bool] = Field(
        default=None,
        description="是否置顶",
        examples=[True],
    )


class SessionResponse(BaseModel):
    """会话统一响应体"""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    pinned: bool
    created_at: datetime
    updated_at: datetime


class CapabilityItem(BaseModel):
    """会话绑定的单项能力开关"""

    capability_type: str = Field(
        ...,
        pattern=r"^(skill|mcp)$",
        description="能力类型：skill 或 mcp",
        examples=["skill"],
    )
    capability_id: UUID = Field(
        ...,
        description="对应 Skill 或 MCP 的唯一 ID",
    )
    enabled: bool = Field(
        default=True,
        description="是否在该会话启用",
    )


class SessionCapabilitiesUpdate(BaseModel):
    """批量更新会话能力开关"""

    capabilities: list[CapabilityItem] = Field(
        default_factory=list,
        description="需批量更新的能力开关列表",
    )


class SessionCapabilitiesResponse(BaseModel):
    """会话能力开关列表响应"""

    session_id: UUID
    capabilities: list[CapabilityItem]
