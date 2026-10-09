from typing import Any, Optional
from uuid import UUID
from supabase import Client

from core.config import settings
from core.database import get_supabase_client
from core.exceptions import AppException, ErrorCode
from models.schemas.mcp import McpServerCreate, McpServerUpdate


class McpRepository:
    """MCP 连接池数据访问仓储"""

    def __init__(self, client: Optional[Client] = None):
        self._client = client

    @property
    def client(self) -> Client:
        if self._client is None:
            self._client = get_supabase_client()
        return self._client

    async def list_by_user(self, user_id: str) -> list[dict[str, Any]]:
        """获取用户已配置的全部 MCP Server 连接节点"""
        if "placeholder" in settings.SUPABASE_URL:
            return []
        try:
            res = (
                self.client.table("mcp_connections")
                .select("*")
                .eq("user_id", str(user_id))
                .order("created_at", desc=False)
                .execute()
            )
            return res.data or []
        except Exception:
            return []

    async def get_by_id(self, user_id: str, server_id: UUID) -> Optional[dict[str, Any]]:
        """根据 ID 查询用户所属的 MCP Server"""
        if "placeholder" in settings.SUPABASE_URL:
            return None
        try:
            res = (
                self.client.table("mcp_connections")
                .select("*")
                .eq("id", str(server_id))
                .eq("user_id", str(user_id))
                .execute()
            )
            if not res.data:
                return None
            return res.data[0]
        except Exception:
            return None

    async def get_by_name(self, user_id: str, name: str) -> Optional[dict[str, Any]]:
        """根据名称查询节点"""
        if "placeholder" in settings.SUPABASE_URL:
            return None
        try:
            res = (
                self.client.table("mcp_connections")
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


    async def create(
        self, user_id: str, server_in: McpServerCreate, tools: Optional[list[dict[str, Any]]] = None
    ) -> dict[str, Any]:
        """新建 MCP Server 连接记录"""
        # 检查重名
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

        payload = {
            "user_id": str(user_id),
            "name": server_in.name,
            "connection_type": server_in.connection_type,
            "connection_config": config,
            "tools": tools or [],
            "enabled": server_in.enabled,
        }

        res = self.client.table("mcp_connections").insert(payload).execute()
        if not res.data:
            raise AppException(
                code=ErrorCode.INTERNAL_SERVER_ERROR,
                message="创建 MCP 连接记录失败",
            )
        return res.data[0]

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
            # 查重
            existing = await self.get_by_name(user_id, update_in.name)
            if existing:
                raise AppException(
                    code=ErrorCode.VALIDATION_ERROR,
                    message=f"已存在同名 MCP 节点 [{update_in.name}]",
                )
            update_payload["name"] = update_in.name

        if update_in.connection_config is not None:
            update_payload["connection_config"] = update_in.connection_config

        if update_in.enabled is not None:
            update_payload["enabled"] = update_in.enabled

        if not update_payload:
            return current

        res = (
            self.client.table("mcp_connections")
            .update(update_payload)
            .eq("id", str(server_id))
            .eq("user_id", str(user_id))
            .execute()
        )
        return res.data[0]

    async def update_tools(
        self, user_id: str, server_id: UUID, tools: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """更新探测到的工具列表清单"""
        res = (
            self.client.table("mcp_connections")
            .update({"tools": tools})
            .eq("id", str(server_id))
            .eq("user_id", str(user_id))
            .execute()
        )
        if not res.data:
            raise AppException(
                code=ErrorCode.NOT_FOUND,
                message="更新工具清单失败，节点不存在",
            )
        return res.data[0]

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

        self.client.table("mcp_connections").delete().eq("id", str(server_id)).eq(
            "user_id", str(user_id)
        ).execute()
        return True
