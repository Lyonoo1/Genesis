import asyncio
import json
import logging
from typing import Any, Optional
from uuid import uuid4
import httpx

from core.exceptions import AppException, ErrorCode

logger = logging.getLogger("genesis.mcp")


class McpClient:
    """异步 MCP 协议客户端：支持标准 JSON-RPC 2.0 规范，兼容 Remote SSE/HTTP 与 Local Stdio 进程管道。"""

    def __init__(self, timeout: float = 20.0):
        self.timeout = timeout

    async def _call_remote_jsonrpc(
        self, endpoint: str, method: str, params: Optional[dict[str, Any]] = None, env: Optional[dict[str, str]] = None
    ) -> dict[str, Any]:
        """向远程 MCP 服务端发送 JSON-RPC 2.0 HTTP 请求"""
        req_id = str(uuid4())
        payload = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {},
            "id": req_id,
        }

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if env:
            # 允许将额外鉴权信息作为请求头传递
            for k, v in env.items():
                if k.upper().startswith("HTTP_") or "TOKEN" in k.upper() or "KEY" in k.upper():
                    headers[k] = v

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(endpoint, json=payload, headers=headers)
                resp.raise_for_status()

                # 解析返回值
                content_type = resp.headers.get("content-type", "")
                if "application/json" in content_type:
                    data = resp.json()
                else:
                    # 尝试解析行式 SSE 或纯文本
                    text = resp.text.strip()
                    if text.startswith("data:"):
                        text = text[5:].strip()
                    data = json.loads(text)

                if "error" in data:
                    err = data["error"]
                    raise AppException(
                        code=ErrorCode.MCP_TOOL_ERROR,
                        message=f"MCP 远程服务端返回错误: {err.get('message', '未知错误')}",
                        details=err,
                    )

                return data.get("result", {})

        except httpx.RequestError as exc:
            logger.error("MCP Remote 连接异常 [%s]: %s", endpoint, str(exc))
            raise AppException(
                code=ErrorCode.MCP_CONNECTION_ERROR,
                message=f"无法连接远程 MCP Server [{endpoint}]: {str(exc)}",
                details={"endpoint": endpoint, "error": str(exc)},
            )
        except json.JSONDecodeError as exc:
            logger.error("MCP Remote JSON 解析失败: %s", str(exc))
            raise AppException(
                code=ErrorCode.MCP_TOOL_ERROR,
                message="MCP Server 返回了非法的 JSON-RPC 报文",
                details={"error": str(exc)},
            )

    async def _call_stdio_jsonrpc(
        self, command: str, args: Optional[list[str]], method: str, params: Optional[dict[str, Any]] = None, env: Optional[dict[str, str]] = None
    ) -> dict[str, Any]:
        """通过标准输入输出 (Stdio) 管道与本地 MCP Server 交互"""
        req_id = str(uuid4())
        payload = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {},
            "id": req_id,
        }
        input_data = (json.dumps(payload) + "\n").encode("utf-8")

        cmd_args = args or []
        try:
            proc = await asyncio.create_subprocess_exec(
                command,
                *cmd_args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )

            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=input_data),
                timeout=self.timeout,
            )

            if proc.returncode != 0:
                err_msg = stderr.decode().strip()
                raise AppException(
                    code=ErrorCode.MCP_TOOL_ERROR,
                    message=f"本地 MCP 进程异常退出 (Code {proc.returncode}): {err_msg}",
                )

            stdout_text = stdout.decode().strip()
            # 取出最后一行有效的 JSON-RPC 响应
            last_line = ""
            for line in stdout_text.splitlines():
                line = line.strip()
                if line.startswith("{") and line.endswith("}"):
                    last_line = line

            if not last_line:
                raise AppException(
                    code=ErrorCode.MCP_TOOL_ERROR,
                    message="本地 MCP 进程未输出有效的 JSON 响应",
                    details={"stdout": stdout_text, "stderr": stderr.decode()},
                )

            data = json.loads(last_line)
            if "error" in data:
                err = data["error"]
                raise AppException(
                    code=ErrorCode.MCP_TOOL_ERROR,
                    message=f"本地 MCP 返回错误: {err.get('message', '未知错误')}",
                    details=err,
                )

            return data.get("result", {})

        except asyncio.TimeoutError:
            raise AppException(
                code=ErrorCode.MCP_CONNECTION_ERROR,
                message=f"本地 MCP 进程执行超时 (>{self.timeout}s)",
            )
        except Exception as exc:
            if isinstance(exc, AppException):
                raise exc
            raise AppException(
                code=ErrorCode.MCP_CONNECTION_ERROR,
                message=f"执行本地 MCP 指令失败: {str(exc)}",
            )

    async def list_tools(self, connection: dict[str, Any]) -> list[dict[str, Any]]:
        """向指定的 MCP Server 发起 tools/list 探测"""
        conn_type = connection.get("connection_type", "remote_url")
        config = connection.get("connection_config") or {}

        if conn_type == "remote_url":
            endpoint = config.get("endpoint")
            if not endpoint:
                raise AppException(
                    code=ErrorCode.VALIDATION_ERROR,
                    message="remote_url 模式必须配置 endpoint",
                )
            result = await self._call_remote_jsonrpc(
                endpoint=endpoint,
                method="tools/list",
                params={},
                env=config.get("env"),
            )
        else:
            command = config.get("command")
            if not command:
                raise AppException(
                    code=ErrorCode.VALIDATION_ERROR,
                    message="local_command 模式必须配置 command",
                )
            result = await self._call_stdio_jsonrpc(
                command=command,
                args=config.get("args") or [],
                method="tools/list",
                params={},
                env=config.get("env"),
            )

        tools = result.get("tools", [])
        return tools

    async def call_tool(
        self, connection: dict[str, Any], tool_name: str, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        """向指定的 MCP Server 发起 tools/call 工具调用"""
        conn_type = connection.get("connection_type", "remote_url")
        config = connection.get("connection_config") or {}
        params = {"name": tool_name, "arguments": arguments}

        if conn_type == "remote_url":
            endpoint = config.get("endpoint")
            if not endpoint:
                raise AppException(
                    code=ErrorCode.VALIDATION_ERROR,
                    message="remote_url 模式必须配置 endpoint",
                )
            return await self._call_remote_jsonrpc(
                endpoint=endpoint,
                method="tools/call",
                params=params,
                env=config.get("env"),
            )
        else:
            command = config.get("command")
            if not command:
                raise AppException(
                    code=ErrorCode.VALIDATION_ERROR,
                    message="local_command 模式必须配置 command",
                )
            return await self._call_stdio_jsonrpc(
                command=command,
                args=config.get("args") or [],
                method="tools/call",
                params=params,
                env=config.get("env"),
            )


# 全局单例管理器与别名
McpClientManager = McpClient
mcp_client_manager = McpClient()

