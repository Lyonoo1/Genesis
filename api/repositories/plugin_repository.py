from typing import Any, Optional
from uuid import UUID

from core.exceptions import AppException, ErrorCode
from models.schemas.marketplace import PluginUploadDraft
from core.sqlite_db import (
    db_list_my_plugins,
    db_get_my_plugin_by_id,
    db_create_my_plugin,
    get_db_connection,
)


class PluginRepository:
    """自研插件数据访问仓储 (基于 SQLite 单机物理持久化)"""

    def __init__(self, client: Optional[Any] = None):
        self._client = client

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        """获取用户自研插件列表"""
        return db_list_my_plugins(str(user_id))

    async def get_by_id(self, user_id: str, plugin_id: UUID) -> Optional[dict[str, Any]]:
        """按 ID 查询插件草稿"""
        return db_get_my_plugin_by_id(str(user_id), str(plugin_id))

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
        return db_create_my_plugin(payload)

    async def delete(self, user_id: str, plugin_id: UUID) -> bool:
        """删除插件草稿"""
        item = await self.get_by_id(user_id, plugin_id)
        if not item:
            raise AppException(
                code=ErrorCode.NOT_FOUND,
                message="指定的插件草稿不存在",
            )
        with get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "DELETE FROM my_plugins WHERE id = ? AND user_id = ?",
                (str(plugin_id), str(user_id)),
            )
            conn.commit()
            return cursor.rowcount > 0


plugin_repository = PluginRepository()
