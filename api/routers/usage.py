from fastapi import APIRouter, Depends, Query

from core.security import get_current_user, AuthenticatedUser
from models.schemas.usage import UsageSummaryResponse
from services.usage_service import UsageService, usage_service

router = APIRouter(prefix="/usage", tags=["Usage & Cost Audit"])


def get_usage_service() -> UsageService:
    return usage_service


@router.get(
    "/summary",
    response_model=UsageSummaryResponse,
    summary="获取用量消耗趋势与多模型高精度成本审计概览",
)
async def get_usage_summary(
    range: str = Query("month", description="时间范围: week | month | year"),
    user: AuthenticatedUser = Depends(get_current_user),
    service: UsageService = Depends(get_usage_service),
):
    summary = await service.get_summary(user_id=user.id, range_type=range)
    return summary
