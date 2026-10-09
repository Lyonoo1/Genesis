from typing import Any, Optional


class ToolAdapter:
    """工具适配器：负责将多源能力（MCP Server、本地 Skill）统一适配为 OpenAI 标准 Function Calling Schema，并完成命名空间双向解析。"""

    MCP_PREFIX = "mcp__"
    SKILL_PREFIX = "skill__"

    @classmethod
    def mcp_to_standard_tool(cls, server_name: str, tool: dict[str, Any]) -> dict[str, Any]:
        """将 MCP 探测到的工具定义封装为 OpenAI 官方 Function Calling 格式，并注入服务器隔离命名空间。

        Example:
            server_name: "github"
            tool: {"name": "create_issue", "description": "...", "inputSchema": {...}}
            Output:
            {
                "type": "function",
                "function": {
                    "name": "mcp__github__create_issue",
                    "description": "...",
                    "parameters": {...}
                }
            }
        """
        raw_name = tool.get("name", "")
        clean_server = server_name.strip().replace("-", "_")
        namespaced_name = f"{cls.MCP_PREFIX}{clean_server}__{raw_name}"

        params = tool.get("inputSchema")
        if not isinstance(params, dict) or not params:
            params = {"type": "object", "properties": {}}

        return {
            "type": "function",
            "function": {
                "name": namespaced_name,
                "description": tool.get("description") or f"Execute {raw_name} on {server_name}",
                "parameters": params,
            },
        }

    @classmethod
    def skill_to_standard_tool(cls, skill: dict[str, Any]) -> dict[str, Any]:
        """将本地已安装 Skill 的 manifest 转换为标准 Function Calling Schema"""
        raw_name = skill.get("name", "").strip().replace("-", "_")
        namespaced_name = f"{cls.SKILL_PREFIX}{raw_name}"
        manifest = skill.get("manifest") or {}

        params = manifest.get("parameters") or {"type": "object", "properties": {}}

        return {
            "type": "function",
            "function": {
                "name": namespaced_name,
                "description": manifest.get("description")
                or skill.get("description")
                or f"Run skill {raw_name}",
                "parameters": params,
            },
        }

    @classmethod
    def parse_namespaced_tool(cls, full_name: str) -> tuple[str, str, str]:
        """解析 LLM 产出的工具名称，返回 (kind, target_identifier, method_name)

        Returns:
            ("mcp", server_name, tool_name)
            ("skill", skill_name, "")
            ("unknown", "", full_name)
        """
        if full_name.startswith(cls.MCP_PREFIX):
            parts = full_name[len(cls.MCP_PREFIX) :].split("__", 1)
            if len(parts) == 2:
                return "mcp", parts[0], parts[1]
            return "mcp", parts[0], ""

        if full_name.startswith(cls.SKILL_PREFIX):
            skill_name = full_name[len(cls.SKILL_PREFIX) :]
            return "skill", skill_name, ""

        return "unknown", "", full_name
