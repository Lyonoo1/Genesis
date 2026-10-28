from typing import Any, Optional
from uuid import UUID
import uuid

from core.config import settings
from core.exceptions import AppException, ErrorCode
from models.schemas.skill import SkillInstallRequest
from core.sqlite_db import (
    db_list_installed_skills,
    db_get_installed_skill_by_id,
    db_get_installed_skill_by_name,
    db_insert_installed_skill,
    db_update_installed_skill_auto_trigger,
    db_delete_installed_skill,
)


class SkillRepository:
    """已安装 Skill 仓储数据访问层 (优先 SQLite 单机物理持久化，可选 Supabase 云端同步)"""

    def __init__(self, client: Optional[Any] = None):
        self._client = client

    @property
    def client(self):
        if self._client is None and settings.has_active_supabase:
            try:
                from core.database import get_supabase_client
                self._client = get_supabase_client()
            except Exception:
                self._client = None
        return self._client

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        """获取当前用户已安装的全部 Skill 清单"""
        skills = db_list_installed_skills(str(user_id))
        if skills:
            return skills

        if self.client:
            try:
                res = (
                    self.client.table("installed_skills")
                    .select("*")
                    .eq("user_id", str(user_id))
                    .order("installed_at", desc=True)
                    .execute()
                )
                if res.data:
                    for s in res.data:
                        db_insert_installed_skill(s)
                    return res.data
            except Exception:
                pass
        return skills

    async def get_by_id(self, user_id: str, skill_id: UUID) -> Optional[dict[str, Any]]:
        """根据技能 ID 与用户 ID 查询 Skill 详情"""
        skill = db_get_installed_skill_by_id(str(user_id), str(skill_id))
        if skill:
            return skill

        if self.client:
            try:
                res = (
                    self.client.table("installed_skills")
                    .select("*")
                    .eq("id", str(skill_id))
                    .eq("user_id", str(user_id))
                    .execute()
                )
                if res.data:
                    db_insert_installed_skill(res.data[0])
                    return res.data[0]
            except Exception:
                pass
        return None

    async def get_by_name(self, user_id: str, name: str) -> Optional[dict[str, Any]]:
        """根据技能唯一名称查询"""
        skill = db_get_installed_skill_by_name(str(user_id), name)
        if skill:
            return skill

        if self.client:
            try:
                res = (
                    self.client.table("installed_skills")
                    .select("*")
                    .eq("name", name)
                    .eq("user_id", str(user_id))
                    .execute()
                )
                if res.data:
                    db_insert_installed_skill(res.data[0])
                    return res.data[0]
            except Exception:
                pass
        return None

    async def install(
        self, user_id: str, skill_in: SkillInstallRequest
    ) -> dict[str, Any]:
        """安装新技能并记录入库"""
        existing = await self.get_by_name(user_id, skill_in.name)
        if existing:
            raise AppException(
                code=ErrorCode.VALIDATION_ERROR,
                message=f"已安装同名技能 [{skill_in.name}]",
            )

        sid = str(uuid.uuid4())
        payload = {
            "id": sid,
            "user_id": str(user_id),
            "name": skill_in.name,
            "version": skill_in.version,
            "storage_path": skill_in.storage_path,
            "manifest": skill_in.manifest.model_dump(),
            "auto_trigger": skill_in.auto_trigger,
        }

        saved = db_insert_installed_skill(payload)

        if self.client:
            try:
                self.client.table("installed_skills").insert(payload).execute()
            except Exception:
                pass

        return saved

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

        updated = db_update_installed_skill_auto_trigger(
            str(user_id), str(skill_id), auto_trigger
        )

        if self.client:
            try:
                self.client.table("installed_skills").update(
                    {"auto_trigger": auto_trigger}
                ).eq("id", str(skill_id)).eq("user_id", str(user_id)).execute()
            except Exception:
                pass

        return updated or skill

    async def delete(self, user_id: str, skill_id: UUID) -> bool:
        """卸载并物理删除技能记录"""
        skill = await self.get_by_id(user_id, skill_id)
        if not skill:
            raise AppException(
                code=ErrorCode.NOT_FOUND,
                message="指定的技能不存在",
            )

        db_delete_installed_skill(str(user_id), str(skill_id))

        if self.client:
            try:
                self.client.table("installed_skills").delete().eq(
                    "id", str(skill_id)
                ).eq("user_id", str(user_id)).execute()
            except Exception:
                pass

        return True
