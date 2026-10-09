from typing import Any, Optional
from uuid import UUID
from supabase import Client

from core.config import settings
from core.database import get_supabase_client
from core.exceptions import AppException, ErrorCode
from models.schemas.skill import SkillInstallRequest


class SkillRepository:
    """已安装 Skill 仓储数据访问层"""

    def __init__(self, client: Optional[Client] = None):
        self._client = client

    @property
    def client(self) -> Client:
        if self._client is None:
            self._client = get_supabase_client()
        return self._client

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        """获取当前用户已安装的全部 Skill 清单"""
        if "placeholder" in settings.SUPABASE_URL:
            return []
        try:
            res = (
                self.client.table("installed_skills")
                .select("*")
                .eq("user_id", str(user_id))
                .order("installed_at", desc=True)
                .execute()
            )
            return res.data or []
        except Exception:
            return []


    async def get_by_id(self, user_id: str, skill_id: UUID) -> Optional[dict[str, Any]]:
        """根据技能 ID 与用户 ID 查询 Skill 详情"""
        if "placeholder" in settings.SUPABASE_URL:
            return None
        try:
            res = (
                self.client.table("installed_skills")
                .select("*")
                .eq("id", str(skill_id))
                .eq("user_id", str(user_id))
                .execute()
            )
            if not res.data:
                return None
            return res.data[0]
        except Exception:
            return None

    async def get_by_name(self, user_id: str, name: str) -> Optional[dict[str, Any]]:
        """根据技能唯一名称查询"""
        if "placeholder" in settings.SUPABASE_URL:
            return None
        try:
            res = (
                self.client.table("installed_skills")
                .select("*")
                .eq("name", name)
                .eq("user_id", str(user_id))
                .execute()
            )
            if not res.data:
                return None
            return res.data[0]
        except Exception:
            return None


    async def install(
        self, user_id: str, skill_in: SkillInstallRequest
    ) -> dict[str, Any]:
        """安装新技能并记录入库"""
        # 1. 唯一性防重复检验
        existing = await self.get_by_name(user_id, skill_in.name)
        if existing:
            raise AppException(
                code=ErrorCode.VALIDATION_ERROR,
                message=f"已安装同名技能 [{skill_in.name}]",
            )

        payload = {
            "user_id": str(user_id),
            "name": skill_in.name,
            "version": skill_in.version,
            "storage_path": skill_in.storage_path,
            "manifest": skill_in.manifest.model_dump(),
            "auto_trigger": skill_in.auto_trigger,
        }

        res = self.client.table("installed_skills").insert(payload).execute()
        if not res.data:
            raise AppException(
                code=ErrorCode.INTERNAL_SERVER_ERROR,
                message="安装技能记录入库失败",
            )
        return res.data[0]

    async def update_auto_trigger(
        self, user_id: str, skill_id: UUID, auto_trigger: bool
    ) -> dict[str, Any]:
        """切换技能的 Agent 自动感知触发开关"""
        skill = await self.get_by_id(user_id, skill_id)
        if not skill:
            raise AppException(
                code=ErrorCode.NOT_FOUND,
                message="指定的技能不存在",
            )

        res = (
            self.client.table("installed_skills")
            .update({"auto_trigger": auto_trigger})
            .eq("id", str(skill_id))
            .eq("user_id", str(user_id))
            .execute()
        )
        if not res.data:
            raise AppException(
                code=ErrorCode.INTERNAL_SERVER_ERROR,
                message="更新技能自动感知开关失败",
            )
        return res.data[0]

    async def delete(self, user_id: str, skill_id: UUID) -> bool:
        """卸载并物理删除技能记录"""
        skill = await self.get_by_id(user_id, skill_id)
        if not skill:
            raise AppException(
                code=ErrorCode.NOT_FOUND,
                message="指定的技能不存在",
            )

        self.client.table("installed_skills").delete().eq("id", str(skill_id)).eq(
            "user_id", str(user_id)
        ).execute()
        return True
