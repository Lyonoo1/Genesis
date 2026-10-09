import logging
from typing import Optional
from uuid import UUID

from models.schemas.usage import UsageLogCreate, UsageSummaryResponse

logger = logging.getLogger("genesis.usage")

# 官方标准单价表 (单位: 美元 / 每百万 Token)
MODEL_PRICING: dict[str, dict[str, float]] = {
    "claude-3-5-sonnet-20241022": {"input": 3.00, "output": 15.00},
    "claude-3-haiku-20240307": {"input": 0.25, "output": 1.25},
    "gpt-4o": {"input": 2.50, "output": 10.00},
    "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    "deepseek-chat": {"input": 0.14, "output": 0.28},
    "deepseek-reasoner": {"input": 0.55, "output": 2.19},
}


def calculate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """根据大模型官方定价高精度核算 Token 费用 (保留 6 位小数)"""
    # 模糊匹配模型名称
    matched_pricing = None
    for k, p in MODEL_PRICING.items():
        if k in model.lower():
            matched_pricing = p
            break
    if not matched_pricing:
        matched_pricing = {"input": 2.50, "output": 10.00}

    cost = (input_tokens / 1_000_000 * matched_pricing["input"]) + (
        output_tokens / 1_000_000 * matched_pricing["output"]
    )
    return round(cost, 6)


class UsageService:
    """精细化用量核算与成本审计服务"""

    def __init__(self, repo=None):
        self.repo = repo

    def get_repo(self):
        if self.repo is None:
            from repositories.usage_repository import usage_repository
            self.repo = usage_repository
        return self.repo

    async def log_turn_usage(
        self,
        user_id: str,
        session_id: UUID,
        model: str,
        input_tokens: int,
        output_tokens: int,
        skill_id: Optional[UUID] = None,
    ) -> dict:
        """记录单轮对话/工具调用的 Token 消耗并精准核算 USD 成本"""
        cost_usd = calculate_cost(model, input_tokens, output_tokens)
        repo = self.get_repo()
        record = await repo.create(
            user_id=user_id,
            usage_in=UsageLogCreate(
                session_id=session_id,
                skill_id=skill_id,
                model=model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            ),
            cost_usd=cost_usd,
        )
        logger.info(
            "用户 [%s] 会话 [%s] 模型 [%s] 消耗 %d in / %d out Tokens, 计费 $%0.6f",
            user_id,
            session_id,
            model,
            input_tokens,
            output_tokens,
            cost_usd,
        )
        return record

    async def get_summary(self, user_id: str, range_type: str = "month") -> UsageSummaryResponse:
        """查询用户维度的用量趋势图表与成本汇总"""
        repo = self.get_repo()
        return await repo.get_summary(user_id=user_id, range_type=range_type)


# 全局单例
usage_service = UsageService()
