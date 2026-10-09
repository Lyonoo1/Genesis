from datetime import datetime
from typing import Any, Optional
from pydantic import BaseModel, ConfigDict, Field


class ProjectCreate(BaseModel):
    """创建项目入参"""

    name: str = Field(..., min_length=1, max_length=100, description="项目名称")
    icon: Optional[str] = Field(default=None, description="图标标识")
    description: Optional[str] = Field(default=None, description="项目描述/备注")
    id: Optional[str] = Field(default=None, description="可选客户端指定的 UUID")


class ProjectUpdate(BaseModel):
    """更新项目入参"""

    name: Optional[str] = Field(
        default=None, min_length=1, max_length=100, description="新项目名称"
    )
    icon: Optional[str] = Field(default=None, description="图标标识")
    description: Optional[str] = Field(default=None, description="项目描述/备注")
    is_expanded: Optional[bool] = Field(default=None, description="是否展开")
    is_archived: Optional[bool] = Field(default=None, description="是否归档")


class ProjectResponse(BaseModel):
    """项目统一响应体"""

    model_config = ConfigDict(from_attributes=True)

    id: Any
    user_id: Any
    name: str
    icon: Optional[str] = None
    description: Optional[str] = None
    is_expanded: bool = True
    is_archived: bool = False
    created_at: Any
    updated_at: Any
