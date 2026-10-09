from typing import Any, Optional
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field


class UsageLogCreate(BaseModel):
    """单次用量日志入库入参"""

    session_id: Any
    skill_id: Optional[UUID] = None
    model: str = Field(..., description="调用的模型名称")
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)


class DailyUsagePoint(BaseModel):
    """按日用量趋势图数据点"""

    date: str = Field(..., description="日期 YYYY-MM-DD")
    input_tokens: int
    output_tokens: int
    cost_usd: float


class TopSkillUsage(BaseModel):
    """Top 消耗技能分析统计"""

    skill_id: Optional[str]
    skill_name: str
    call_count: int
    total_tokens: int
    cost_usd: float


class UsageSummaryResponse(BaseModel):
    """用量与成本聚合响应体"""

    total_input_tokens: int
    total_output_tokens: int
    total_cost_usd: float
    daily_points: list[DailyUsagePoint]
    top_skills: list[TopSkillUsage]
