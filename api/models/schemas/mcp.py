from datetime import datetime
from typing import Any, Optional
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field


class McpToolItem(BaseModel):
    """单项 MCP 探测发现的工具定义"""

    name: str = Field(..., description="工具标识名称", examples=["create_issue"])
    description: Optional[str] = Field(
        default="", description="工具功能用途描述", examples=["在指定仓库创建跟踪 Issue"]
    )
    inputSchema: Optional[dict[str, Any]] = Field(
        default_factory=lambda: {"type": "object", "properties": {}},
        description="JSON Schema 参数输入规范",
    )
    enabled: bool = Field(default=True, description="该工具是否允许被 Agent 调用")


class McpServerCreate(BaseModel):
    """注册/连接新 MCP Server 请求体"""

    name: str = Field(
        ...,
        min_length=1,
        max_length=50,
        pattern=r"^[a-zA-Z0-9_\-]+$",
        description="Server 节点别名（仅支持字母、数字、下划线与中划线）",
        examples=["github-mcp"],
    )
    connection_type: str = Field(
        default="remote_url",
        pattern=r"^(remote_url|local_command)$",
        description="连接传输模式：remote_url 或 local_command",
        examples=["remote_url"],
    )
    endpoint: Optional[str] = Field(
        default=None,
        description="remote_url 模式下的 HTTP/SSE 端点地址",
        examples=["https://mcp.github.com/v1/sse"],
    )
    command: Optional[str] = Field(
        default=None,
        description="local_command 模式下的执行主命令",
        examples=["npx"],
    )
    args: Optional[list[str]] = Field(
        default=None,
        description="local_command 模式下的执行参数列表",
        examples=["-y", "@modelcontextprotocol/server-postgres"],
    )
    env: Optional[dict[str, str]] = Field(
        default=None,
        description="环境变量补充字典",
        examples=[{"GITHUB_TOKEN": "ghp_xxxx"}],
    )
    enabled: bool = Field(default=True, description="是否立即启用该 Server")


class McpServerUpdate(BaseModel):
    """更新 MCP Server 请求体"""

    name: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=50,
        pattern=r"^[a-zA-Z0-9_\-]+$",
        description="新节点别名",
    )
    connection_config: Optional[dict[str, Any]] = Field(
        default=None,
        description="连接配置体覆盖",
    )
    enabled: Optional[bool] = Field(default=None, description="节点启停状态")


class McpServerResponse(BaseModel):
    """MCP Server 统一查询响应体"""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    connection_type: str
    connection_config: dict[str, Any]
    tools: list[McpToolItem] = []
    enabled: bool
    created_at: datetime
    status: str = Field(
        default="online",
        description="实时连接探活状态：online, connecting, offline",
    )


class McpToolToggle(BaseModel):
    """工具单个启停入参"""

    enabled: bool = Field(..., description="是否启用该工具")


class McpToolCallRequest(BaseModel):
    """手动/调试调用 MCP 工具入参"""

    server_id: UUID = Field(..., description="所属 Server 节点 ID")
    tool_name: str = Field(..., description="原生工具名称（不含前缀）")
    arguments: dict[str, Any] = Field(
        default_factory=dict, description="传给工具的实参字典"
    )


class McpToolCallResponse(BaseModel):
    """MCP 工具调用执行结果响应体"""

    server_id: UUID
    tool_name: str
    result: Any = None
    is_error: bool = False
    error_message: Optional[str] = None
    latency_ms: Optional[int] = None
