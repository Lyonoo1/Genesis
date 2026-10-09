from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID
from supabase import Client

from core.config import settings
from core.database import get_supabase_client
from core.exceptions import AppException, ErrorCode
from models.schemas.usage import (
    UsageLogCreate,
    DailyUsagePoint,
    TopSkillUsage,
    UsageSummaryResponse,
)

_MEMORY_USAGE_LOGS: list[dict[str, Any]] = []


class UsageRepository:
    """用量与成本数据访问仓储"""

    def __init__(self, client: Optional[Client] = None):
        self._client = client

    @property
    def client(self) -> Client:
        if self._client is None:
            self._client = get_supabase_client()
        return self._client

    async def create(
        self, user_id: str, usage_in: UsageLogCreate, cost_usd: float
    ) -> dict[str, Any]:
        """向 usage_logs 插入一条用量记录"""
        payload = {
            "id": f"log-{len(_MEMORY_USAGE_LOGS) + 1}",
            "user_id": str(user_id),
            "session_id": str(usage_in.session_id),
            "skill_id": str(usage_in.skill_id) if usage_in.skill_id else None,
            "model": usage_in.model,
            "input_tokens": usage_in.input_tokens,
            "output_tokens": usage_in.output_tokens,
            "cost_usd": cost_usd,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

        if "placeholder" in settings.SUPABASE_URL:
            _MEMORY_USAGE_LOGS.append(payload)
            return payload

        try:
            res = self.client.table("usage_logs").insert(payload).execute()
            if res.data:
                return res.data[0]
        except Exception:
            pass

        _MEMORY_USAGE_LOGS.append(payload)
        return payload

    async def list_by_user(self, user_id: str, limit: int = 500) -> list[dict[str, Any]]:
        """拉取指定用户近期的用量明细记录"""
        if "placeholder" in settings.SUPABASE_URL:
            return list(reversed(_MEMORY_USAGE_LOGS[-limit:]))

        try:
            res = (
                self.client.table("usage_logs")
                .select("*")
                .eq("user_id", str(user_id))
                .order("created_at", desc=True)
                .limit(limit)
                .execute()
            )
            return res.data or []
        except Exception:
            return list(reversed(_MEMORY_USAGE_LOGS[-limit:]))


    async def get_summary(self, user_id: str, range_type: str = "month") -> UsageSummaryResponse:
        """内存聚合生成仪表盘数据（兼容无状态与各种数据库方言）"""
        logs = await self.list_by_user(user_id=user_id, limit=1000)

        total_in = 0
        total_out = 0
        total_cost = 0.0

        daily_map: dict[str, dict[str, Any]] = {}
        skill_map: dict[str, dict[str, Any]] = {}

        for log in logs:
            inp = log.get("input_tokens") or 0
            out = log.get("output_tokens") or 0
            cost = float(log.get("cost_usd") or 0.0)

            total_in += inp
            total_out += out
            total_cost += cost

            # 按日期统计 YYYY-MM-DD
            created_at_str = log.get("created_at") or ""
            day_str = created_at_str[:10] if len(created_at_str) >= 10 else "2026-09-15"
            if day_str not in daily_map:
                daily_map[day_str] = {
                    "date": day_str,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cost_usd": 0.0,
                }
            daily_map[day_str]["input_tokens"] += inp
            daily_map[day_str]["output_tokens"] += out
            daily_map[day_str]["cost_usd"] += cost

            # 按 Skill 统计
            skill_id = log.get("skill_id")
            if skill_id:
                s_key = str(skill_id)
                if s_key not in skill_map:
                    skill_map[s_key] = {
                        "skill_id": s_key,
                        "skill_name": log.get("model") or "Custom Skill",
                        "call_count": 0,
                        "total_tokens": 0,
                        "cost_usd": 0.0,
                    }
                skill_map[s_key]["call_count"] += 1
                skill_map[s_key]["total_tokens"] += inp + out
                skill_map[s_key]["cost_usd"] += cost

        # 排序每日数据点
        daily_points = [
            DailyUsagePoint(
                date=v["date"],
                input_tokens=v["input_tokens"],
                output_tokens=v["output_tokens"],
                cost_usd=round(v["cost_usd"], 6),
            )
            for v in sorted(daily_map.values(), key=lambda x: x["date"])
        ]

        # Top Skill 排行
        top_skills = [
            TopSkillUsage(
                skill_id=v["skill_id"],
                skill_name=v["skill_name"],
                call_count=v["call_count"],
                total_tokens=v["total_tokens"],
                cost_usd=round(v["cost_usd"], 6),
            )
            for v in sorted(
                skill_map.values(), key=lambda x: x["cost_usd"], reverse=True
            )[:5]
        ]

        return UsageSummaryResponse(
            total_input_tokens=total_in,
            total_output_tokens=total_out,
            total_cost_usd=round(total_cost, 6),
            daily_points=daily_points,
            top_skills=top_skills,
        )


usage_repository = UsageRepository()
