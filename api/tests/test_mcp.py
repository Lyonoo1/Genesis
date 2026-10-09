import uuid
from datetime import datetime, timezone
from typing import Any, Optional
import pytest
from fastapi.testclient import TestClient

from main import app
from core.security import get_current_user, AuthenticatedUser
from routers.mcp import get_mcp_repository
from repositories.mcp_repository import McpRepository
from models.schemas.mcp import McpServerCreate, McpServerUpdate
from services.tool_adapter import ToolAdapter
from services.mcp_client import mcp_client_manager
from core.exceptions import AppException, ErrorCode


# ----------------------------------------------------------------------
# 1. 纯逻辑单测：ToolAdapter Schema 转换与双向路由解析
# ----------------------------------------------------------------------


def test_tool_adapter_mcp_conversion():
    """测试 MCP 工具转 OpenAI Function Calling Schema 及命名空间注入"""
    server_name = "github-mcp"
    tool_raw = {
        "name": "create_issue",
        "description": "在指定仓库创建 issue",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "body": {"type": "string"},
            },
            "required": ["title"],
        },
    }

    standard_tool = ToolAdapter.mcp_to_standard_tool(server_name, tool_raw)
    assert standard_tool["type"] == "function"
    fn = standard_tool["function"]
    assert fn["name"] == "mcp__github_mcp__create_issue"
    assert fn["description"] == "在指定仓库创建 issue"
    assert fn["parameters"]["required"] == ["title"]


def test_tool_adapter_skill_conversion():
    """测试 Skill 转换为 OpenAI Function Calling Schema"""
    skill = {
        "name": "code-analyzer",
        "manifest": {
            "description": "代码语法树解析",
            "parameters": {
                "type": "object",
                "properties": {"file_path": {"type": "string"}},
            },
        },
    }
    tool = ToolAdapter.skill_to_standard_tool(skill)
    assert tool["type"] == "function"
    assert tool["function"]["name"] == "skill__code_analyzer"
    assert "file_path" in tool["function"]["parameters"]["properties"]


def test_tool_adapter_reverse_namespace_resolution():
    """测试多态工具调用命名空间反向解析"""
    # 1. MCP 工具
    kind, target, method = ToolAdapter.parse_namespaced_tool("mcp__github__create_issue")
    assert kind == "mcp"
    assert target == "github"
    assert method == "create_issue"

    # 2. Skill 工具
    kind, target, method = ToolAdapter.parse_namespaced_tool("skill__code_analyzer")
    assert kind == "skill"
    assert target == "code_analyzer"
    assert method == ""

    # 3. 未知工具
    kind, target, method = ToolAdapter.parse_namespaced_tool("custom_builtin")
    assert kind == "unknown"


# ----------------------------------------------------------------------
# 2. 内存模拟仓储，验证 MCP 端到端 REST 路由
# ----------------------------------------------------------------------


class InMemoryMcpRepository(McpRepository):
    def __init__(self):
        super().__init__(client=None)
        self.servers: dict[str, dict] = {}

    async def list_by_user(self, user_id: str):
        return [s for s in self.servers.values() if s["user_id"] == str(user_id)]

    async def get_by_id(self, user_id: str, server_id: uuid.UUID):
        s = self.servers.get(str(server_id))
        if s and s["user_id"] == str(user_id):
            return s
        return None

    async def get_by_name(self, user_id: str, name: str):
        for s in self.servers.values():
            if s["user_id"] == str(user_id) and s["name"] == name:
                return s
        return None

    async def create(self, user_id: str, server_in: McpServerCreate, tools=None):
        if await self.get_by_name(user_id, server_in.name):
            raise AppException(code=ErrorCode.VALIDATION_ERROR, message="已存在同名节点")

        s_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        server = {
            "id": s_id,
            "user_id": str(user_id),
            "name": server_in.name,
            "connection_type": server_in.connection_type,
            "connection_config": {
                "endpoint": server_in.endpoint,
                "command": server_in.command,
                "args": server_in.args or [],
                "env": server_in.env or {},
            },
            "tools": tools or [],
            "enabled": server_in.enabled,
            "created_at": now,
        }
        self.servers[s_id] = server
        return server

    async def update(self, user_id: str, server_id: uuid.UUID, update_in: McpServerUpdate):
        s = await self.get_by_id(user_id, server_id)
        if not s:
            raise AppException(code=ErrorCode.NOT_FOUND, message="节点不存在", status_code=404)
        if update_in.name is not None:
            s["name"] = update_in.name
        if update_in.enabled is not None:
            s["enabled"] = update_in.enabled
        return s

    async def update_tools(self, user_id: str, server_id: uuid.UUID, tools: list[dict]):
        s = await self.get_by_id(user_id, server_id)
        if not s:
            raise AppException(code=ErrorCode.NOT_FOUND, message="节点不存在", status_code=404)
        s["tools"] = tools
        return s

    async def toggle_tool(self, user_id: str, server_id: uuid.UUID, tool_name: str, enabled: bool):
        s = await self.get_by_id(user_id, server_id)
        if not s:
            raise AppException(code=ErrorCode.NOT_FOUND, message="节点不存在", status_code=404)
        for t in s.get("tools", []):
            if t["name"] == tool_name:
                t["enabled"] = enabled
                return s
        raise AppException(code=ErrorCode.NOT_FOUND, message="工具不存在", status_code=404)

    async def delete(self, user_id: str, server_id: uuid.UUID):
        s = await self.get_by_id(user_id, server_id)
        if not s:
            raise AppException(code=ErrorCode.NOT_FOUND, message="节点不存在", status_code=404)
        del self.servers[str(server_id)]
        return True


TEST_USER_ID = "00000000-0000-0000-0000-000000000001"


@pytest.fixture
def mock_env(monkeypatch):
    in_memory_repo = InMemoryMcpRepository()
    mock_user = AuthenticatedUser(
        user_id=TEST_USER_ID, email="developer@genesis.local"
    )

    app.dependency_overrides[get_current_user] = lambda: mock_user
    app.dependency_overrides[get_mcp_repository] = lambda: in_memory_repo

    # 模拟探测发现的返回工具
    async def mock_list_tools(conn):
        return [
            {
                "name": "query_schema",
                "description": "获取数据表 Schema",
                "inputSchema": {"type": "object", "properties": {"table": {"type": "string"}}},
            },
            {
                "name": "explain_query",
                "description": "解释 SQL 执行计划",
                "inputSchema": {"type": "object"},
            },
        ]

    # 模拟工具执行
    async def mock_call_tool(conn, tool_name, arguments):
        return {"rows": [{"table_name": "users"}, {"table_name": "sessions"}]}

    monkeypatch.setattr(mcp_client_manager, "list_tools", mock_list_tools)
    monkeypatch.setattr(mcp_client_manager, "call_tool", mock_call_tool)

    client = TestClient(app)
    yield client, in_memory_repo
    app.dependency_overrides.clear()


def test_mcp_server_lifecycle_and_discovery(mock_env):
    """测试 MCP Server 节点注册、工具主动探测、刷新、单项工具开关与删除"""
    client, repo = mock_env

    # 1. 注册新节点
    res = client.post(
        "/api/mcp/servers",
        json={
            "name": "postgres-probe",
            "connection_type": "remote_url",
            "endpoint": "https://mcp.db.internal/v1",
            "enabled": True,
        },
    )
    assert res.status_code == 201
    data = res.json()
    server_id = data["id"]
    assert data["name"] == "postgres-probe"
    # 自动探测到 2 个工具
    assert len(data["tools"]) == 2
    assert data["tools"][0]["name"] == "query_schema"
    assert data["tools"][0]["enabled"] is True

    # 2. 获取列表
    list_res = client.get("/api/mcp/servers")
    assert list_res.status_code == 200
    servers = list_res.json()
    assert len(servers) == 1

    # 3. 单项工具开关切换 (Disable query_schema)
    toggle_res = client.put(
        f"/api/mcp/servers/{server_id}/tools/query_schema",
        json={"enabled": False},
    )
    assert toggle_res.status_code == 200
    updated_tools = toggle_res.json()["tools"]
    query_schema_tool = next(t for t in updated_tools if t["name"] == "query_schema")
    assert query_schema_tool["enabled"] is False

    # 4. 手动触发刷新，验证既有启停偏好被保留
    refresh_res = client.post(f"/api/mcp/servers/{server_id}/refresh")
    assert refresh_res.status_code == 200
    refreshed_tools = refresh_res.json()["tools"]
    refreshed_query_schema = next(t for t in refreshed_tools if t["name"] == "query_schema")
    assert refreshed_query_schema["enabled"] is False

    # 5. 直接测试调用工具
    call_res = client.post(
        "/api/mcp/call",
        json={
            "server_id": server_id,
            "tool_name": "query_schema",
            "arguments": {"table": "users"},
        },
    )
    assert call_res.status_code == 200
    call_data = call_res.json()
    assert call_data["is_error"] is False
    assert "rows" in call_data["result"]

    # 6. 删除节点
    del_res = client.delete(f"/api/mcp/servers/{server_id}")
    assert del_res.status_code == 204

    # 再次拉取已为空
    assert len(client.get("/api/mcp/servers").json()) == 0
