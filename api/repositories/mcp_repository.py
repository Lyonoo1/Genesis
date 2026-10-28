from typing import Any, Optional
from uuid import UUID
import uuid

from core.config import settings
from core.exceptions import AppException, ErrorCode
from models.schemas.mcp import McpServerCreate, McpServerUpdate
from core.sqlite_db import (
    db_list_mcp_connections,
    db_get_mcp_connection_by_id,
    db_get_mcp_connection_by_name,
    db_create_mcp_connection,
    db_update_mcp_connection,
    db_delete_mcp_connection,
)


class McpRepository:
    """MCP 连接池数据访问仓储 (优先 SQLite 单机物理持久化，可选 Supabase 云端同步)"""

    def __init__(self, client: Optional[Any] = None):
        self._client = client

    @property
    def client(self):
        if self._client is None and "placeholder" not in settings.SUPABASE_URL:
            try:
                from core.database import get_supabase_client
                self._client = get_supabase_client()
            except Exception:
                self._client = None
        return self._client

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        """获取用户已配置的全部 MCP Server 连接节点"""
        nodes = db_list_mcp_connections(str(user_id))
        if nodes:
            return nodes

        if self.client:
            try:
                res = (
                    self.client.table("mcp_connections")
                    .select("*")
                    .eq("user_id", str(user_id))
                    .order("created_at", desc=False)
                    .execute()
                )
                if res.data:
                    for n in res.data:
                        db_create_mcp_connection(n)
                    return res.data
            except Exception:
                pass
        return nodes

    async def get_by_id(self, user_id: str, server_id: UUID) -> Optional[dict[str, Any]]:
        """根据 ID 查询用户所属的 MCP Server"""
        node = db_get_mcp_connection_by_id(str(user_id), str(server_id))
        if node:
            return node

        if self.client:
            try:
                res = (
                    self.client.table("mcp_connections")
                    .select("*")
                    .eq("id", str(server_id))
                    .eq("user_id", str(user_id))
                    .execute()
                )
                if res.data:
                    db_create_mcp_connection(res.data[0])
                    return res.data[0]
            except Exception:
                pass
        return None

    async def get_by_name(self, user_id: str, name: str) -> Optional[dict[str, Any]]:
        """根据名称查询节点"""
        node = db_get_mcp_connection_by_name(str(user_id), name)
        if node:
            return node

        if self.client:
            try:
                res = (
                    self.client.table("mcp_connections")
                    .select("*")
                    .eq("name", name)
                    .eq("user_id", str(user_id))
                    .execute()
                )
                if res.data:
                    db_create_mcp_connection(res.data[0])
                    return res.data[0]
            except Exception:
                pass
        return None

    async def create(
        self, user_id: str, server_in: McpServerCreate, tools: Optional[list[dict[str, Any]]] = None
    ) -> dict[str, Any]:
        """新建 MCP Server 连接记录"""
        existing = await self.get_by_name(user_id, server_in.name)
        if existing:
            raise AppException(
                code=ErrorCode.VALIDATION_ERROR,
                message=f"已存在同名 MCP 节点 [{server_in.name}]",
            )

        config: dict[str, Any] = {}
        if server_in.connection_type == "remote_url":
            config["endpoint"] = server_in.endpoint
        else:
            config["command"] = server_in.command
            config["args"] = server_in.args or []
        if server_in.env:
            config["env"] = server_in.env

        sid = str(uuid.uuid4())
        payload = {
            "id": sid,
            "user_id": str(user_id),
            "name": server_in.name,
            "connection_type": server_in.connection_type,
            "config": config,
            "connection_config": config,
            "tools": tools or [],
            "status": "connected" if tools else "disconnected",
            "enabled": server_in.enabled,
        }

        saved = db_create_mcp_connection(payload)

        if self.client:
            try:
                self.client.table("mcp_connections").insert(payload).execute()
            except Exception:
                pass

        return saved

    async def update(
        self, user_id: str, server_id: UUID, update_in: McpServerUpdate
    ) -> dict[str, Any]:
        """更新节点属性与配置"""
        current = await self.get_by_id(user_id, server_id)
        if not current:
            raise AppException(
                code=ErrorCode.NOT_FOUND,
                message="指定的 MCP 节点不存在",
            )

        update_payload: dict[str, Any] = {}
        if update_in.name is not None and update_in.name != current["name"]:
            existing = await self.get_by_name(user_id, update_in.name)
            if existing:
                raise AppException(
                    code=ErrorCode.VALIDATION_ERROR,
                    message=f"已存在同名 MCP 节点 [{update_in.name}]",
                )
            update_payload["name"] = update_in.name

        if update_in.connection_config is not None:
            update_payload["config"] = update_in.connection_config
            update_payload["connection_config"] = update_in.connection_config

        if update_in.enabled is not None:
            update_payload["enabled"] = update_in.enabled

        if not update_payload:
            return current

        updated = db_update_mcp_connection(str(user_id), str(server_id), update_payload)

        if self.client:
            try:
                self.client.table("mcp_connections").update(update_payload).eq(
                    "id", str(server_id)
                ).eq("user_id", str(user_id)).execute()
            except Exception:
                pass

        return updated or current

    async def update_tools(
        self, user_id: str, server_id: UUID, tools: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """更新探测到的工具列表清单"""
        updated = db_update_mcp_connection(
            str(user_id), str(server_id), {"tools": tools, "status": "connected"}
        )

        if self.client:
            try:
                self.client.table("mcp_connections").update(
                    {"tools": tools, "status": "connected"}
                ).eq("id", str(server_id)).eq("user_id", str(user_id)).execute()
            except Exception:
                pass

        if not updated:
            raise AppException(
                code=ErrorCode.NOT_FOUND,
                message="更新工具清单失败，节点不存在",
            )
        return updated

    async def toggle_tool(
        self, user_id: str, server_id: UUID, tool_name: str, enabled: bool
    ) -> dict[str, Any]:
        """启停某一个工具项"""
        server = await self.get_by_id(user_id, server_id)
        if not server:
            raise AppException(
                code=ErrorCode.NOT_FOUND,
                message="指定的 MCP 节点不存在",
            )

        tools: list[dict[str, Any]] = server.get("tools") or []
        found = False
        for t in tools:
            if t.get("name") == tool_name:
                t["enabled"] = enabled
                found = True
                break

        if not found:
            raise AppException(
                code=ErrorCode.NOT_FOUND,
                message=f"未在节点中找到名为 [{tool_name}] 的工具",
            )

        return await self.update_tools(user_id, server_id, tools)

    async def delete(self, user_id: str, server_id: UUID) -> bool:
        """删除 MCP 节点配置"""
        server = await self.get_by_id(user_id, server_id)
        if not server:
            raise AppException(
                code=ErrorCode.NOT_FOUND,
                message="指定的 MCP 节点不存在",
            )

        db_delete_mcp_connection(str(user_id), str(server_id))

        if self.client:
            try:
                self.client.table("mcp_connections").delete().eq(
                    "id", str(server_id)
                ).eq("user_id", str(user_id)).execute()
            except Exception:
                pass

        return True
