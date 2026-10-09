from datetime import datetime
from typing import Any, Optional
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field


class SkillManifest(BaseModel):
    """Skill 规范元数据清单 (manifest.json)"""

    name: str = Field(..., min_length=1, max_length=60, description="技能唯一标识")
    version: str = Field(default="1.0.0", description="语义化版本号")
    description: Optional[str] = Field(default="", description="技能功能描述")
    entrypoint: str = Field(default="main.py", description="沙箱执行入口脚本名")
    permissions: list[str] = Field(
        default_factory=list,
        description="沙箱权限清单，如 ['read:file', 'exec:sandbox']",
    )
    parameters: Optional[dict[str, Any]] = Field(
        default_factory=lambda: {"type": "object", "properties": {}},
        description="OpenAI Function Calling 兼容的输入参数 JSON Schema",
    )


class SkillInstallRequest(BaseModel):
    """安装新 Skill 入参"""

    name: str = Field(..., min_length=1, max_length=60, description="技能标识")
    version: str = Field(default="1.0.0", description="版本号")
    storage_path: str = Field(..., description="Supabase Storage 中的归档 zip 路径")
    manifest: SkillManifest = Field(..., description="技能描述清单")
    auto_trigger: bool = Field(default=True, description="是否参与 Agent 自动感知触发")


class SkillAutoTriggerToggle(BaseModel):
    """自动感知开关切换"""

    auto_trigger: bool = Field(..., description="是否允许 Agent 自动识别并调用")


class SkillResponse(BaseModel):
    """已安装 Skill 统一响应体"""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    version: str
    storage_path: str
    local_dir: Optional[str] = None
    manifest: dict[str, Any]
    auto_trigger: bool
    installed_at: datetime


class SkillExecuteRequest(BaseModel):
    """调试/手动调用 Skill 入参"""

    arguments: dict[str, Any] = Field(
        default_factory=dict, description="传给沙箱 stdin 的参数字典"
    )
    timeout: int = Field(default=30, ge=1, le=120, description="超时强杀阈值(秒)")


class SkillExecuteResponse(BaseModel):
    """Skill 沙箱执行结果响应体"""

    skill_id: UUID
    skill_name: str
    result: Any = None
    is_error: bool = False
    error_message: Optional[str] = None
    latency_ms: Optional[int] = None
