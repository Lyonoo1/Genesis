from datetime import datetime, timezone
from typing import Any, Optional
import uuid as uuid_mod
from supabase import Client

from core.database import get_supabase_client
from core.exceptions import AppException, ErrorCode
from core.config import settings
from core.sqlite_db import (
    db_list_sessions,
    db_get_session,
    db_upsert_session,
    db_delete_session,
)
from models.schemas.session import (
    SessionCreate,
    SessionUpdate,
    CapabilityItem,
)


class SessionRepository:
    """会话与能力开关数据访问仓储（基于本地 SQLite 物理落地，兼备 Supabase 云端同步）"""

    def __init__(self, client: Optional[Client] = None):
        self._client = client

    @property
    def client(self) -> Client:
        if self._client is None:
            self._client = get_supabase_client()
        return self._client

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        """获取用户全部会话，置顶在前，更新时间倒序"""
        sessions = db_list_sessions(str(user_id))
        if sessions:
            return sessions

        if "placeholder" not in settings.SUPABASE_URL:
            try:
                res = (
                    self.client.table("sessions")
                    .select("*")
                    .eq("user_id", str(user_id))
                    .order("pinned", desc=True)
                    .order("updated_at", desc=True)
                    .execute()
                )
                if res.data:
                    for s in res.data:
                        db_upsert_session(s)
                    return res.data
            except Exception:
                pass
        return sessions

    async def get_by_id(
        self, user_id: str, session_id: Any
    ) -> Optional[dict[str, Any]]:
        """根据 ID 获取单个属于该用户的会话"""
        sid = str(session_id)
        sess = db_get_session(str(user_id), sid)
        if sess:
            return sess

        if "placeholder" not in settings.SUPABASE_URL:
            try:
                res = (
                    self.client.table("sessions")
                    .select("*")
                    .eq("id", sid)
                    .eq("user_id", str(user_id))
                    .execute()
                )
                if res.data:
                    db_upsert_session(res.data[0])
                    return res.data[0]
            except Exception:
                pass

        # 会话若不存在，物理落地并返回初始化会话
        now = datetime.now(timezone.utc).isoformat()
        new_sess = {
            "id": sid,
            "user_id": str(user_id),
            "title": "新对话",
            "pinned": False,
            "is_archived": False,
            "created_at": now,
            "updated_at": now,
        }
        return db_upsert_session(new_sess)

    async def create(
        self, user_id: str, session_in: SessionCreate
    ) -> dict[str, Any]:
        """创建新会话"""
        sid = str(session_in.id) if session_in.id else str(uuid_mod.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        payload = {
            "id": sid,
            "user_id": str(user_id),
            "title": session_in.title or "新对话",
            "pinned": False,
            "is_archived": False,
            "project_id": str(session_in.project_id) if session_in.project_id else None,
            "created_at": now,
            "updated_at": now,
        }
        saved = db_upsert_session(payload)

        if "placeholder" not in settings.SUPABASE_URL:
            try:
                self.client.table("sessions").insert(payload).execute()
            except Exception:
                pass

        return saved

    async def update(
        self, user_id: str, session_id: Any, session_in: SessionUpdate
    ) -> dict[str, Any]:
        """更新会话标题或置顶状态"""
        sid = str(session_id)
        sess = await self.get_by_id(user_id, sid)
        if not sess:
            raise AppException(
                code=ErrorCode.SESSION_NOT_FOUND,
                message="目标会话不存在或无权操作",
                status_code=404,
            )

        now = datetime.now(timezone.utc).isoformat()
        if session_in.title is not None:
            sess["title"] = session_in.title
        if session_in.pinned is not None:
            sess["pinned"] = session_in.pinned
        if "project_id" in session_in.model_fields_set:
            sess["project_id"] = str(session_in.project_id) if session_in.project_id else None
        if session_in.is_archived is not None:
            sess["is_archived"] = session_in.is_archived
        sess["updated_at"] = now

        saved = db_upsert_session(sess)

        if "placeholder" not in settings.SUPABASE_URL:
            try:
                update_data = {
                    "updated_at": now,
                }
                if session_in.title is not None:
                    update_data["title"] = session_in.title
                if session_in.pinned is not None:
                    update_data["pinned"] = session_in.pinned
                if "project_id" in session_in.model_fields_set:
                    update_data["project_id"] = str(session_in.project_id) if session_in.project_id else None
                if session_in.is_archived is not None:
                    update_data["is_archived"] = session_in.is_archived
                self.client.table("sessions").update(update_data).eq("id", sid).eq("user_id", str(user_id)).execute()
            except Exception:
                pass

        return saved

    async def delete(self, user_id: str, session_id: Any) -> bool:
        """物理级联删除会话"""
        sid = str(session_id)
        db_delete_session(str(user_id), sid)

        if "placeholder" not in settings.SUPABASE_URL:
            try:
                self.client.table("sessions").delete().eq("id", sid).eq("user_id", str(user_id)).execute()
            except Exception:
                pass

        return True

    async def get_capabilities(
        self, user_id: str, session_id: Any
    ) -> list[dict[str, Any]]:
        """获取当前会话的能力开关配置"""
        sid = str(session_id)
        session = await self.get_by_id(user_id, sid)
        if not session:
            raise AppException(
                code=ErrorCode.SESSION_NOT_FOUND,
                message="会话不存在或无权查看",
                status_code=404,
            )

        if "placeholder" not in settings.SUPABASE_URL:
            try:
                res = (
                    self.client.table("session_capabilities")
                    .select("*")
                    .eq("session_id", sid)
                    .execute()
                )
                return res.data or []
            except Exception:
                return []
        return []

    async def update_capabilities(
        self,
        user_id: str,
        session_id: Any,
        capabilities: list[CapabilityItem],
    ) -> list[dict[str, Any]]:
        """批量更新会话能力开关配置"""
        sid = str(session_id)
        session = await self.get_by_id(user_id, sid)
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
                "session_id": sid,
                "capability_type": item.capability_type,
                "capability_id": str(item.capability_id),
                "enabled": item.enabled,
            }
            for item in capabilities
        ]

        if "placeholder" not in settings.SUPABASE_URL:
            try:
                res = (
                    self.client.table("session_capabilities")
                    .upsert(records, on_conflict="session_id,capability_type,capability_id")
                    .execute()
                )
                return res.data or records
            except Exception:
                return records
        return records
