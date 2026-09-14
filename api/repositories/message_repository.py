from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID
from supabase import Client

from core.database import get_supabase_client
from core.exceptions import AppException, ErrorCode
from models.schemas.message import MessageCreate


class MessageRepository:
    """消息持久化与分支管理仓储"""

    def __init__(self, client: Optional[Client] = None):
        self._client = client

    @property
    def client(self) -> Client:
        if self._client is None:
            self._client = get_supabase_client()
        return self._client

    async def list_by_session(
        self,
        session_id: UUID,
        user_id: str,
        limit: int = 20,
        cursor: Optional[str] = None,
    ) -> tuple[list[dict[str, Any]], Optional[str], bool]:
        """拉取指定会话的历史消息（基于时间游标反向翻页，返回按时间正序排列）"""
        query = (
            self.client.table("messages")
            .select("*")
            .eq("session_id", str(session_id))
            .eq("user_id", str(user_id))
        )

        if cursor:
            # 游标向前翻页（拉取早于 cursor 时间戳的历史记录）
            query = query.lt("created_at", cursor)

        # 降序查询 limit + 1 条判断是否有更多
        res = (
            query.order("created_at", desc=True)
            .limit(limit + 1)
            .execute()
        )
        data = res.data or []

        has_more = len(data) > limit
        items = data[:limit]

        next_cursor = None
        if has_more and items:
            next_cursor = items[-1]["created_at"]

        # 调回时间正序输出给前端渲染
        items.reverse()
        return items, next_cursor, has_more

    async def create(
        self, user_id: str, message_in: MessageCreate
    ) -> dict[str, Any]:
        """插入新消息并联动刷新会话 updated_at"""
        payload: dict[str, Any] = {
            "session_id": str(message_in.session_id),
            "user_id": str(user_id),
            "role": message_in.role.value if hasattr(message_in.role, "value") else str(message_in.role),
            "content": message_in.content,
            "parent_id": str(message_in.parent_id) if message_in.parent_id else None,
            "tool_call_id": message_in.tool_call_id,
            "active_skill_id": str(message_in.active_skill_id) if message_in.active_skill_id else None,
            "status": message_in.status.value if hasattr(message_in.status, "value") else str(message_in.status),
        }

        if message_in.raw_tool_calls is not None:
            payload["raw_tool_calls"] = [
                item.model_dump() if hasattr(item, "model_dump") else item
                for item in message_in.raw_tool_calls
            ]

        res = self.client.table("messages").insert(payload).execute()
        if not res.data:
            raise AppException(
                code=ErrorCode.INTERNAL_SERVER_ERROR,
                message="插入消息失败，数据库未返回记录",
            )

        # 联动刷新会话更新时间，保持列表排序最新
        self.client.table("sessions").update(
            {"updated_at": datetime.now(timezone.utc).isoformat()}
        ).eq("id", str(message_in.session_id)).eq("user_id", str(user_id)).execute()

        return res.data[0]

    async def prune_branch(
        self, session_id: UUID, user_id: str, parent_id: UUID
    ) -> int:
        """分支修剪 (Branch Pruning): 物理删除晚于 parent_id 时间戳的所有后续分支消息"""
        # 1. 查找指定父节点的创建时间戳
        parent_res = (
            self.client.table("messages")
            .select("created_at")
            .eq("id", str(parent_id))
            .eq("session_id", str(session_id))
            .eq("user_id", str(user_id))
            .execute()
        )

        if not parent_res.data:
            raise AppException(
                code=ErrorCode.NOT_FOUND,
                message="父节点消息不存在或无权访问",
                status_code=404,
            )

        parent_created_at = parent_res.data[0]["created_at"]

        # 2. 物理清除晚于该节点的所有历史消息
        del_res = (
            self.client.table("messages")
            .delete()
            .eq("session_id", str(session_id))
            .eq("user_id", str(user_id))
            .gt("created_at", parent_created_at)
            .execute()
        )

        pruned_count = len(del_res.data or [])
        return pruned_count
