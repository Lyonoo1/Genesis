from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID
import uuid as uuid_mod
from supabase import Client

from core.database import get_supabase_client
from core.exceptions import AppException, ErrorCode
from core.config import settings
from core.sqlite_db import (
    db_list_messages,
    db_create_message,
    db_prune_messages,
)
from models.schemas.message import MessageCreate


class MessageRepository:
    """消息持久化与分支管理仓储（基于本地 SQLite 物理落地，兼备 Supabase 云端同步）"""

    def __init__(self, client: Optional[Client] = None):
        self._client = client

    @property
    def client(self) -> Client:
        if self._client is None:
            self._client = get_supabase_client()
        return self._client

    async def list_by_session(
        self,
        session_id: Any,
        user_id: str,
        limit: int = 50,
        cursor: Optional[str] = None,
    ) -> tuple[list[dict[str, Any]], Optional[str], bool]:
        """拉取指定会话的历史消息（基于时间游标反向翻页，返回按时间正序排列）"""
        sid = str(session_id)
        items, next_cursor, has_more = db_list_messages(
            session_id=sid, user_id=str(user_id), limit=limit, cursor_time=cursor
        )
        if items:
            return items, next_cursor, has_more

        # 若本地为空且有真实 Supabase 配置，尝试同步
        if "placeholder" not in settings.SUPABASE_URL:
            try:
                query = (
                    self.client.table("messages")
                    .select("*")
                    .eq("session_id", sid)
                    .eq("user_id", str(user_id))
                )
                if cursor:
                    query = query.lt("created_at", cursor)

                res = query.order("created_at", desc=True).limit(limit + 1).execute()
                data = res.data or []
                has_more = len(data) > limit
                items = data[:limit]
                next_cursor = items[-1]["created_at"] if has_more and items else None
                items.reverse()
                for m in items:
                    db_create_message(m)
                return items, next_cursor, has_more
            except Exception:
                pass

        return items, next_cursor, has_more

    async def create(
        self,
        user_id: str,
        message_in: Optional[MessageCreate] = None,
        msg_in: Optional[MessageCreate] = None,
        **kwargs,
    ) -> dict[str, Any]:
        """插入新消息并联动刷新会话 updated_at"""
        actual_in = msg_in or message_in
        if not actual_in:
            raise ValueError("message_in or msg_in must be provided")

        role_str = actual_in.role.value if hasattr(actual_in.role, "value") else str(actual_in.role)
        status_str = actual_in.status.value if hasattr(actual_in.status, "value") else str(actual_in.status)

        payload: dict[str, Any] = {
            "id": str(uuid_mod.uuid4()),
            "session_id": str(actual_in.session_id),
            "user_id": str(user_id),
            "role": role_str,
            "content": actual_in.content,
            "reasoning_content": getattr(actual_in, "reasoning_content", None),
            "parent_id": str(actual_in.parent_id) if actual_in.parent_id else None,
            "tool_call_id": actual_in.tool_call_id,
            "active_skill_id": str(actual_in.active_skill_id) if actual_in.active_skill_id else None,
            "status": status_str,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

        if actual_in.raw_tool_calls is not None:
            payload["raw_tool_calls"] = [
                item.model_dump() if hasattr(item, "model_dump") else item
                for item in actual_in.raw_tool_calls
            ]

        # 物理落盘 SQLite
        saved = db_create_message(payload)

        # 尝试云端同步
        if "placeholder" not in settings.SUPABASE_URL:
            try:
                self.client.table("messages").insert(payload).execute()
            except Exception:
                pass

        return saved

    async def prune_branch(
        self, session_id: Any, user_id: str, parent_id: Any
    ) -> int:
        """分支修剪 (Branch Pruning): 物理删除晚于 parent_id 时间戳的所有后续分支消息"""
        sid = str(session_id)
        pid = str(parent_id)
        pruned_count = db_prune_messages(session_id=sid, user_id=str(user_id), parent_id=pid)

        if "placeholder" not in settings.SUPABASE_URL:
            try:
                parent_res = (
                    self.client.table("messages")
                    .select("created_at")
                    .eq("id", pid)
                    .eq("session_id", sid)
                    .eq("user_id", str(user_id))
                    .execute()
                )
                if parent_res.data:
                    parent_created_at = parent_res.data[0]["created_at"]
                    self.client.table("messages").delete().eq("session_id", sid).eq("user_id", str(user_id)).gt("created_at", parent_created_at).execute()
            except Exception:
                pass

        return pruned_count
