from typing import Any, Optional
from uuid import UUID
from supabase import Client

from core.database import get_supabase_client
from core.exceptions import AppException, ErrorCode
from models.schemas.marketplace import PluginUploadDraft


class PluginRepository:
    """自研插件数据访问仓储 (my_plugins 表)"""

    def __init__(self, client: Optional[Client] = None):
        self._client = client

    @property
    def client(self) -> Client:
        if self._client is None:
            self._client = get_supabase_client()
        return self._client

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        """获取用户自研插件列表"""
        res = (
            self.client.table("my_plugins")
            .select("*")
            .eq("user_id", str(user_id))
            .order("created_at", desc=True)
            .execute()
        )
        return res.data or []

    async def get_by_id(self, user_id: str, plugin_id: UUID) -> Optional[dict[str, Any]]:
        """按 ID 查询插件草稿"""
        res = (
            self.client.table("my_plugins")
            .select("*")
            .eq("id", str(plugin_id))
            .eq("user_id", str(user_id))
            .execute()
        )
        if not res.data:
            return None
        return res.data[0]

    async def create_draft(
        self, user_id: str, draft_in: PluginUploadDraft
    ) -> dict[str, Any]:
        """创建或更新自研插件草稿"""
        payload = {
            "user_id": str(user_id),
            "name": draft_in.name,
            "manifest": draft_in.manifest,
            "storage_path": draft_in.storage_path,
            "status": "draft",
        }
        res = self.client.table("my_plugins").insert(payload).execute()
        if not res.data:
            raise AppException(
                code=ErrorCode.INTERNAL_SERVER_ERROR,
                message="保存插件草稿失败",
            )
        return res.data[0]

    async def delete(self, user_id: str, plugin_id: UUID) -> bool:
        """删除插件草稿"""
        item = await self.get_by_id(user_id, plugin_id)
        if not item:
            raise AppException(
                code=ErrorCode.NOT_FOUND,
                message="指定的插件草稿不存在",
            )
        self.client.table("my_plugins").delete().eq("id", str(plugin_id)).eq(
            "user_id", str(user_id)
        ).execute()
        return True


plugin_repository = PluginRepository()
