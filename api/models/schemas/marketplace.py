from datetime import datetime
from typing import Any, Optional
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field


class MarketplacePluginItem(BaseModel):
    """应用市场展示卡片模型"""

    id: str = Field(..., description="唯一标识，如 frontend-skill 或 mcp-github")
    name: str = Field(..., description="插件/技能显示名称")
    category: str = Field(default="研发工作流", description="分类标签")
    type: str = Field(default="skill", description="类别: skill | mcp")
    scope: str = Field(default="personal", description="作用域: personal | system")
    version: str = Field(default="1.0.0", description="版本号")
    author: str = Field(default="Genesis Official", description="作者或组织")
    description: str = Field(default="", description="功能简要描述")
    readme: str = Field(default="", description="Markdown 详细说明文档")
    permissions: list[str] = Field(default_factory=list, description="权限声明")
    downloads: int = Field(default=0, description="下载量")
    iconType: Optional[str] = Field(default="cube", description="图标类型")
    storage_path: Optional[str] = Field(default=None, description="预置包路径")
    installed: bool = Field(default=False, description="当前用户是否已安装")
    auto_trigger: bool = Field(default=True, description="是否开启自动感知")


class PluginUploadDraft(BaseModel):
    """上传自研插件草稿"""

    name: str = Field(..., min_length=1, max_length=60, description="插件标识")
    manifest: dict[str, Any] = Field(..., description="manifest.json 清单")
    storage_path: Optional[str] = Field(default=None, description="Storage 归档路径")


class PluginDraftResponse(BaseModel):
    """自研插件草稿响应体"""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    manifest: dict[str, Any]
    storage_path: Optional[str] = None
    status: str
    created_at: datetime
