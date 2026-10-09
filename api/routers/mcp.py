from datetime import datetime
import time
from uuid import UUID
from fastapi import APIRouter, Depends, status

from core.security import get_current_user, AuthenticatedUser
from models.schemas.mcp import (
    McpServerCreate,
    McpServerUpdate,
    McpServerResponse,
    McpToolToggle,
    McpToolCallRequest,
    McpToolCallResponse,
)
from repositories.mcp_repository import McpRepository
from services.mcp_client import mcp_client_manager

router = APIRouter(prefix="/mcp", tags=["MCP Management"])


def get_mcp_repository() -> McpRepository:
    return McpRepository()


@router.get(
    "/servers",
    response_model=list[McpServerResponse],
    summary="获取当前用户已连接的 MCP Server 列表",
)
async def list_servers(
    user: AuthenticatedUser = Depends(get_current_user),
    repo: McpRepository = Depends(get_mcp_repository),
):
    servers = await repo.list_by_user(user.id)
    return servers


@router.post(
    "/servers",
    response_model=McpServerResponse,
    status_code=status.HTTP_201_CREATED,
    summary="注册并连接新 MCP Server 节点",
)
async def create_server(
    server_in: McpServerCreate,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: McpRepository = Depends(get_mcp_repository),
):
    # 尝试主动探测工具
    discovered_tools = []
    temp_config = {
        "connection_type": server_in.connection_type,
        "connection_config": {
            "endpoint": server_in.endpoint,
            "command": server_in.command,
            "args": server_in.args or [],
            "env": server_in.env or {},
        },
    }
    try:
        raw_tools = await mcp_client_manager.list_tools(temp_config)
        for t in raw_tools:
            discovered_tools.append(
                {
                    "name": t.get("name"),
                    "description": t.get("description", ""),
                    "inputSchema": t.get("inputSchema")
                    or {"type": "object", "properties": {}},
                    "enabled": True,
                }
            )
    except Exception:
        # 如果初始探测失败，允许先登记节点，稍后手动 refresh
        discovered_tools = []

    server = await repo.create(user.id, server_in, tools=discovered_tools)
    return server


@router.get(
    "/servers/{server_id}",
    response_model=McpServerResponse,
    summary="获取指定 MCP Server 节点详情",
)
async def get_server(
    server_id: UUID,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: McpRepository = Depends(get_mcp_repository),
):
    server = await repo.get_by_id(user.id, server_id)
    if not server:
        from core.exceptions import AppException, ErrorCode

        raise AppException(code=ErrorCode.NOT_FOUND, message="MCP 节点不存在")
    return server


@router.post(
    "/servers/{server_id}/refresh",
    response_model=McpServerResponse,
    summary="手动重新探测远端 MCP 工具列表",
)
async def refresh_server_tools(
    server_id: UUID,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: McpRepository = Depends(get_mcp_repository),
):
    server = await repo.get_by_id(user.id, server_id)
    if not server:
        from core.exceptions import AppException, ErrorCode

        raise AppException(code=ErrorCode.NOT_FOUND, message="MCP 节点不存在")

    raw_tools = await mcp_client_manager.list_tools(server)

    # 保持既有工具的启停偏好
    old_tools = {t["name"]: t.get("enabled", True) for t in (server.get("tools") or [])}
    new_tools = []
    for t in raw_tools:
        name = t.get("name")
        new_tools.append(
            {
                "name": name,
                "description": t.get("description", ""),
                "inputSchema": t.get("inputSchema")
                or {"type": "object", "properties": {}},
                "enabled": old_tools.get(name, True),
            }
        )

    updated = await repo.update_tools(user.id, server_id, new_tools)
    return updated


@router.put(
    "/servers/{server_id}",
    response_model=McpServerResponse,
    summary="更新 MCP Server 节点配置或启停",
)
async def update_server(
    server_id: UUID,
    update_in: McpServerUpdate,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: McpRepository = Depends(get_mcp_repository),
):
    return await repo.update(user.id, server_id, update_in)


@router.put(
    "/servers/{server_id}/tools/{tool_name}",
    response_model=McpServerResponse,
    summary="单项工具启用/禁用开关切换",
)
async def toggle_server_tool(
    server_id: UUID,
    tool_name: str,
    toggle_in: McpToolToggle,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: McpRepository = Depends(get_mcp_repository),
):
    return await repo.toggle_tool(user.id, server_id, tool_name, toggle_in.enabled)


@router.delete(
    "/servers/{server_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除已配置的 MCP Server 节点",
)
async def delete_server(
    server_id: UUID,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: McpRepository = Depends(get_mcp_repository),
):
    await repo.delete(user.id, server_id)
    return None


@router.post(
    "/call",
    response_model=McpToolCallResponse,
    summary="直接测试调用某项 MCP 工具",
)
async def call_tool(
    call_in: McpToolCallRequest,
    user: AuthenticatedUser = Depends(get_current_user),
    repo: McpRepository = Depends(get_mcp_repository),
):
    server = await repo.get_by_id(user.id, call_in.server_id)
    if not server:
        from core.exceptions import AppException, ErrorCode

        raise AppException(code=ErrorCode.NOT_FOUND, message="MCP 节点不存在")

    start_time = time.perf_counter()
    try:
        result = await mcp_client_manager.call_tool(
            server, call_in.tool_name, call_in.arguments
        )
        latency_ms = int((time.perf_counter() - start_time) * 1000)
        return McpToolCallResponse(
            server_id=call_in.server_id,
            tool_name=call_in.tool_name,
            result=result,
            is_error=False,
            latency_ms=latency_ms,
        )
    except Exception as exc:
        latency_ms = int((time.perf_counter() - start_time) * 1000)
        return McpToolCallResponse(
            server_id=call_in.server_id,
            tool_name=call_in.tool_name,
            result=None,
            is_error=True,
            error_message=str(exc),
            latency_ms=latency_ms,
        )
