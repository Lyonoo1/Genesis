from typing import Any, Optional


class ToolAdapter:
    """工具适配器：负责将多源能力（MCP Server、本地 Skill）统一适配为 OpenAI 标准 Function Calling Schema，并完成命名空间双向解析。"""

    MCP_PREFIX = "mcp__"
    SKILL_PREFIX = "skill__"
    WORKSPACE_PREFIX = "workspace__"

    BUILTIN_WORKSPACE_TOOLS: list[dict[str, Any]] = [
        {
            "type": "function",
            "function": {
                "name": "workspace__delete_file",
                "description": "删除当前项目工作区中的指定文件或目录，支持相对路径或通配符表达式（如 '*.asf', 'temp.txt'）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对于工作区根目录的文件/目录相对路径或匹配通配符，例如 'asf.html'、'dist'、'*.log'",
                        }
                    },
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "workspace__write_file",
                "description": "向工作区写入或新建完整文件，若上级目录不存在将自动创建（新建文件时使用）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对于工作区根目录的文件相对路径，例如 'src/index.js'",
                        },
                        "content": {
                            "type": "string",
                            "description": "要写入的文件完整文本内容",
                        },
                        "overwrite": {
                            "type": "boolean",
                            "description": "若目标文件已存在是否允许覆写，默认为 true",
                        },
                    },
                    "required": ["path", "content"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "workspace__edit_file",
                "description": "基于精确局部匹配安全替换文件中的代码块（Claude Code 模式）。修改已有代码时强烈优先使用此工具，严禁全量重写大文件。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对于工作区根目录的文件相对路径",
                        },
                        "old_string": {
                            "type": "string",
                            "description": "目标文件中待替换的原始代码块（必须在文件中全局唯一匹配）",
                        },
                        "new_string": {
                            "type": "string",
                            "description": "替换后的新代码块内容",
                        },
                    },
                    "required": ["path", "old_string", "new_string"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "workspace__read_file",
                "description": "读取工作区中指定文件的文本内容。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对于工作区根目录的文件相对路径，例如 'package.json'",
                        }
                    },
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "workspace__list_dir",
                "description": "列出工作区指定目录下的文件和子目录结构。仅在用户明确需要查看文件列表、目录树或排查代码项目结构时使用，日常问候严禁调用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对于工作区根目录的子目录路径，默认为 '.' (项目根目录)",
                        },
                        "recursive": {
                            "type": "boolean",
                            "description": "是否递归列出所有子目录中的文件，默认为 false",
                        },
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "workspace__execute_command",
                "description": "在项目工作区根目录下执行 Shell/终端命令行指令并返回控制台输出。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "要执行的命令行指令，例如 'ls -la'、'npm test'、'python main.py'",
                        },
                        "is_background": {
                            "type": "boolean",
                            "description": "是否作为长期驻留服务在后台异步执行（例如启动 Web 服务器、watch 任务等）",
                        },
                    },
                    "required": ["command"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "workspace__grep_search",
                "description": "在工作区文件文本内容中检索关键词或正则表达式，返回匹配的文件路径、行号及行内容切片（限制前 50 条匹配，自动排除系统与依赖目录）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "检索的关键词或正则表达式文本",
                        },
                        "path": {
                            "type": "string",
                            "description": "要检索的子目录或特定文件相对路径，默认为 '.'",
                        },
                        "case_sensitive": {
                            "type": "boolean",
                            "description": "是否区分大小写，默认为 false",
                        },
                        "is_regex": {
                            "type": "boolean",
                            "description": "是否作为正则表达式进行检索，默认为 false",
                        },
                    },
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "workspace__find_by_name",
                "description": "在工作区文件树中按文件名或通配符模式查找匹配的文件与目录（限制前 50 条匹配，自动排除系统与依赖目录）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": {
                            "type": "string",
                            "description": "要匹配的文件名或 glob 通配符，例如 '*.py'、'Button.tsx'、'*test*'",
                        },
                        "path": {
                            "type": "string",
                            "description": "要搜索的起始子目录相对路径，默认为 '.'",
                        },
                        "type": {
                            "type": "string",
                            "enum": ["file", "directory", "any"],
                            "description": "仅搜索文件 (file)、仅搜索目录 (directory) 或二者均可 (any)，默认为 any",
                        },
                    },
                    "required": ["pattern"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "workspace__stop_process",
                "description": "根据 PID 停止并关闭在后台运行的守护服务或进程（例如终止 Web 服务器、开发服务等）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pid": {
                            "type": "integer",
                            "description": "要终止的后台进程 PID",
                        },
                    },
                    "required": ["pid"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "workspace__dispatch_subagent",
                "description": "委派独立的只读 Subagent 子代理到代码库进行隔离调查、大范围代码探索或测试验证，避免污染主对话上下文。执行完毕后仅返回高浓缩提炼结果（2,000 字符以内）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "agent_type": {
                            "type": "string",
                            "enum": ["explore", "verify"],
                            "description": "子代理类型：'explore' 用于代码库检索调研与架构分析；'verify' 用于运行测试与排查报错",
                        },
                        "task_prompt": {
                            "type": "string",
                            "description": "详细描述需要子代理独立调查并返回的具体问题与目标",
                        },
                    },
                    "required": ["agent_type", "task_prompt"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "workspace__todo_write",
                "description": "更新和维护当前会话的结构化待办任务状态机（Todo List）。用于长链路工程任务规划、跟踪各子步骤的 pending/in_progress/completed 状态，防止任务中途迷失并实时驱动前端任务看板。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "todos": {
                            "type": "array",
                            "description": "完整的任务状态列表",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": {
                                        "type": "string",
                                        "description": "任务项唯一标识，例如 'task-1', 'step-1'",
                                    },
                                    "content": {
                                        "type": "string",
                                        "description": "任务具体描述与目标",
                                    },
                                    "status": {
                                        "type": "string",
                                        "enum": ["pending", "in_progress", "completed"],
                                        "description": "任务当前状态",
                                    },
                                },
                                "required": ["id", "content", "status"],
                            },
                        },
                    },
                    "required": ["todos"],
                },
            },
        },
    ]

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
            ("workspace", "", method_name)
            ("mcp", server_name, tool_name)
            ("skill", skill_name, "")
            ("unknown", "", full_name)
        """
        if full_name.startswith(cls.WORKSPACE_PREFIX):
            method_name = full_name[len(cls.WORKSPACE_PREFIX) :]
            return "workspace", "", method_name

        if full_name.startswith(cls.MCP_PREFIX):
            parts = full_name[len(cls.MCP_PREFIX) :].split("__", 1)
            if len(parts) == 2:
                return "mcp", parts[0], parts[1]
            return "mcp", parts[0], ""

        if full_name.startswith(cls.SKILL_PREFIX):
            skill_name = full_name[len(cls.SKILL_PREFIX) :]
            return "skill", skill_name, ""

        return "unknown", "", full_name
