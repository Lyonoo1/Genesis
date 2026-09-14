from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID
from supabase import Client

from core.database import get_supabase_client
from core.exceptions import AppException, ErrorCode
from models.schemas.session import (
    SessionCreate,
    SessionUpdate,
    CapabilityItem,
)


class SessionRepository:
    """会话与能力开关数据访问仓储"""

    def __init__(self, client: Optional[Client] = None):
        self._client = client

    @property
    def client(self) -> Client:
        if self._client is None:
            self._client = get_supabase_client()
        return self._client

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        """获取用户全部会话，置顶在前，更新时间倒序"""
        res = (
            self.client.table("sessions")
            .select("*")
            .eq("user_id", str(user_id))
            .order("pinned", desc=True)
            .order("updated_at", desc=True)
            .execute()
        )
        return res.data or []

    async def get_by_id(
        self, user_id: str, session_id: UUID
    ) -> Optional[dict[str, Any]]:
        """根据 ID 获取单个属于该用户的会话"""
        res = (
            self.client.table("sessions")
            .select("*")
            .eq("id", str(session_id))
            .eq("user_id", str(user_id))
            .execute()
        )
        if not res.data:
            return None
        return res.data[0]

    async def create(
        self, user_id: str, session_in: SessionCreate
    ) -> dict[str, Any]:
        """创建新会话"""
        payload = {
            "user_id": str(user_id),
            "title": session_in.title or "新对话",
            "pinned": False,
        }
        res = self.client.table("sessions").insert(payload).execute()
        if not res.data:
            raise AppException(
                code=ErrorCode.INTERNAL_SERVER_ERROR,
                message="创建会话失败，数据库未返回记录",
            )
        return res.data[0]

    async def update(
        self, user_id: str, session_id: UUID, session_in: SessionUpdate
    ) -> dict[str, Any]:
        """更新会话标题或置顶状态"""
        update_data: dict[str, Any] = {
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        if session_in.title is not None:
            update_data["title"] = session_in.title
        if session_in.pinned is not None:
            update_data["pinned"] = session_in.pinned

        res = (
            self.client.table("sessions")
            .update(update_data)
            .eq("id", str(session_id))
            .eq("user_id", str(user_id))
            .execute()
        )
        if not res.data:
            raise AppException(
                code=ErrorCode.SESSION_NOT_FOUND,
                message="目标会话不存在或无权操作",
                status_code=404,
            )
        return res.data[0]

    async def delete(self, user_id: str, session_id: UUID) -> bool:
        """物理级联删除会话"""
        res = (
            self.client.table("sessions")
            .delete()
            .eq("id", str(session_id))
            .eq("user_id", str(user_id))
            .execute()
        )
        if not res.data:
            raise AppException(
                code=ErrorCode.SESSION_NOT_FOUND,
                message="目标会话不存在或无权删除",
                status_code=404,
            )
        return True

    async def get_capabilities(
        self, user_id: str, session_id: UUID
    ) -> list[dict[str, Any]]:
        """获取当前会话的能力开关配置"""
        session = await self.get_by_id(user_id, session_id)
        if not session:
            raise AppException(
                code=ErrorCode.SESSION_NOT_FOUND,
                message="会话不存在或无权查看",
                status_code=404,
            )

        res = (
            self.client.table("session_capabilities")
            .select("*")
            .eq("session_id", str(session_id))
            .execute()
        )
        return res.data or []

    async def update_capabilities(
        self,
        user_id: str,
        session_id: UUID,
        capabilities: list[CapabilityItem],
    ) -> list[dict[str, Any]]:
        """批量更新会话能力开关配置"""
        session = await self.get_by_id(user_id, session_id)
        if not session:
            raise AppException(
                code=ErrorCode.SESSION_NOT_FOUND,
                message="会话不存在或无权配置",
                status_code=404,
            )

        if not capabilities:
            return []

        records = [
            {
                "session_id": str(session_id),
                "capability_type": item.capability_type,
                "capability_id": str(item.capability_id),
                "enabled": item.enabled,
            }
            for item in capabilities
        ]

        res = (
            self.client.table("session_capabilities")
            .upsert(records, on_conflict="session_id,capability_type,capability_id")
            .execute()
        )
        return res.data or records
