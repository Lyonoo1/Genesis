from typing import Any, Optional


class ToolAdapter:
    """工具适配器：负责将多源能力（MCP Server、本地 Skill）统一适配为 OpenAI 标准 Function Calling Schema，并完成命名空间双向解析。"""

    MCP_PREFIX = "mcp__"
    SKILL_PREFIX = "skill__"
    WORKSPACE_PREFIX = "workspace__"
    AGENT_PREFIX = "agent__"

    AGENT_ASK_USER_TOOL: dict[str, Any] = {
        "type": "function",
        "function": {
            "name": "agent__ask_user",
            "description": (
                "向用户发起结构化单选/多选澄清或参数补全表单（单次最多 3 题）。\n"
                "【严格防过度提问红线】：\n"
                "1. 先查后问原则：凡是能通过 workspace__read_file、workspace__grep_search、workspace__list_dir、"
                "检查 package.json/配置文件或现有代码风格推断的信息，绝对禁止调用本工具！\n"
                "2. 允许提问的唯一门槛：仅当遇到 (a) 互斥且不可逆的架构/业务分叉、(b) 缺失无法从仓库获取的外部运行参数"
                "（如环境名、Webhook、阈值，使用 selection_mode='form'）、或 (c) 用户指令存在直接矛盾时才允许调用。\n"
                "3. 默认值强制义务：每道选择题必须将你认为最合理的方案放在 options 第 1 项并标记 recommended: true，"
                "方便用户一键回车或直接跳过。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 3,
                        "description": "澄清问题或参数表单列表（硬上限 3 题）",
                        "items": {
                            "type": "object",
                            "properties": {
                                "item_id": {
                                    "type": "string",
                                    "description": "问题唯一标识，如 'q_arch'",
                                },
                                "title": {
                                    "type": "string",
                                    "description": "简明清晰的问题标题",
                                },
                                "subtitle": {
                                    "type": "string",
                                    "description": "可选的补充背景说明",
                                },
                                "selection_mode": {
                                    "type": "string",
                                    "enum": ["single", "multi", "form"],
                                    "description": "single=单选、multi=多选、form=结构化参数表单",
                                },
                                "auto_advance": {
                                    "type": "boolean",
                                    "description": "仅 single 模式有效，选中后是否自动推进到下一题（默认 true）",
                                },
                                "options": {
                                    "type": "array",
                                    "description": "单选/多选时的候选项，第 1 项应设为最合理方案并标记 recommended: true",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "id": {"type": "string"},
                                            "label": {"type": "string"},
                                            "description": {"type": "string"},
                                            "recommended": {"type": "boolean"},
                                        },
                                        "required": ["id", "label"],
                                    },
                                },
                                "custom_input": {
                                    "type": "object",
                                    "properties": {
                                        "enabled": {"type": "boolean"},
                                        "mode": {
                                            "type": "string",
                                            "enum": ["override", "append"],
                                        },
                                        "placeholder": {"type": "string"},
                                    },
                                },
                                "form_fields": {
                                    "type": "array",
                                    "description": "selection_mode='form' 时的字段定义",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "key": {"type": "string"},
                                            "label": {"type": "string"},
                                            "description": {"type": "string"},
                                            "type": {
                                                "type": "string",
                                                "enum": ["text", "number", "select", "boolean", "json"],
                                            },
                                            "required": {"type": "boolean"},
                                            "placeholder": {"type": "string"},
                                            "default_value": {},
                                            "options": {
                                                "type": "array",
                                                "items": {
                                                    "type": "object",
                                                    "properties": {
                                                        "label": {"type": "string"},
                                                        "value": {"type": "string"},
                                                    },
                                                    "required": ["label", "value"],
                                                },
                                            },
                                            "pattern": {"type": "string"},
                                            "min": {"type": "number"},
                                            "max": {"type": "number"},
                                        },
                                        "required": ["key", "label", "type"],
                                    },
                                },
                            },
                            "required": ["title", "selection_mode"],
                        },
                    }
                },
                "required": ["items"],
            },
        },
    }

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
                "description": "读取工作区中指定文件的文本内容，支持行号探针与 offset/limit 分页截取。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对于工作区根目录的文件相对路径，例如 'package.json'",
                        },
                        "offset": {
                            "type": "integer",
                            "description": "读取起始行号（1-based，默认 1）",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "单次最大读取行数（默认 200 行）",
                        },
                        "with_line_numbers": {
                            "type": "boolean",
                            "description": "是否显式返回带行号格式（默认 False，numbered_content 字段始终生成）",
                        },
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
                "name": "workspace__exec_command",
                "description": "在持久化交互式 PTY 终端中执行命令行指令。支持实时共屏输出、交互式提示挂起检测与智能超时控制。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "cmd": {
                            "type": "string",
                            "description": "要执行的 Shell 命令行指令",
                        },
                        "yield_time_ms": {
                            "type": "integer",
                            "description": "等待命令完成的挂起超时（毫秒），默认 5000",
                        },
                        "is_background": {
                            "type": "boolean",
                            "description": "是否为长期运行的后台开发服务",
                        },
                    },
                    "required": ["cmd"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "workspace__write_stdin",
                "description": "向当前运行的交互式 PTY 终端注入标准输入字符流（支持回车 \\n、Ctrl+C \\x03 等）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "session_id": {
                            "type": "string",
                            "description": "目标 PTY 终端会话标识符",
                        },
                        "input_chars": {
                            "type": "string",
                            "description": "要写入终端的字符流内容，如 'y\\n'、'admin\\n'",
                        },
                        "yield_time_ms": {
                            "type": "integer",
                            "description": "输入后等待终端回显的超时毫秒数，默认 2000",
                        },
                    },
                    "required": ["session_id", "input_chars"],
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
                "name": "workspace__spawn_agent",
                "description": "异步非阻塞派发独立的 Subagent 子代理并发执行任务。explore/verify 申请共享只读锁，code_worker 必须声明 write_scope 申请排他写作用域锁。启动后立即返回 agent_id，可在同轮连续派发多个并行代理。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": {
                            "type": "string",
                            "description": "详细描述子代理需要完成的具体目标与任务说明",
                        },
                        "mode": {
                            "type": "string",
                            "enum": ["explore", "verify", "code_worker"],
                            "description": "子代理工作模式：'explore' 只读探索调研；'verify' 测试运行与定位；'code_worker' 作用域受限写代理",
                        },
                        "fork_context": {
                            "type": "boolean",
                            "description": "是否克隆父会话历史上下文（默认 false，使用纯净沙箱上下文）",
                        },
                        "write_scope": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "code_worker 模式必填：声明该子代理允许写入修改的相对路径或 glob 作用域列表，如 ['src/auth/**', 'tests/*.py']",
                        },
                    },
                    "required": ["task"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "workspace__wait_agent",
                "description": "基于 asyncio 等待目标 agent_ids 列表中的子代理完成。返回已完成子代理的结构化报告与运行中子代理最新快照。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "agent_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "需要等待的目标子代理 ID 列表",
                        },
                        "timeout_ms": {
                            "type": "integer",
                            "description": "最大等待超时毫秒数（默认 30000ms）",
                        },
                        "return_when": {
                            "type": "string",
                            "enum": ["FIRST_COMPLETED", "ALL_COMPLETED"],
                            "description": "等待模式：'FIRST_COMPLETED' 首个完成即返回；'ALL_COMPLETED' 等待全部完成",
                        },
                    },
                    "required": ["agent_ids"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "workspace__send_input",
                "description": "向运行中的指定子代理注入实时纠偏指令，支持抢占中断当前步骤并立即转向新指令。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "agent_id": {
                            "type": "string",
                            "description": "目标子代理 ID",
                        },
                        "message": {
                            "type": "string",
                            "description": "需要注入的纠偏指令文本内容",
                        },
                        "interrupt": {
                            "type": "boolean",
                            "description": "是否立即中断子代理当前步骤（默认 true）",
                        },
                    },
                    "required": ["agent_id", "message"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "workspace__close_agent",
                "description": "单点强制终止指定子代理并立即释放其持有的全部 WorkspaceLockManager 读写锁。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "agent_id": {
                            "type": "string",
                            "description": "要终止的目标子代理 ID",
                        },
                    },
                    "required": ["agent_id"],
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

        if full_name.startswith(cls.AGENT_PREFIX):
            method_name = full_name[len(cls.AGENT_PREFIX) :]
            return "agent", "", method_name

        if full_name.startswith(cls.MCP_PREFIX):
            parts = full_name[len(cls.MCP_PREFIX) :].split("__", 1)
            if len(parts) == 2:
                return "mcp", parts[0], parts[1]
            return "mcp", parts[0], ""

        if full_name.startswith(cls.SKILL_PREFIX):
            skill_name = full_name[len(cls.SKILL_PREFIX) :]
            return "skill", skill_name, ""

        return "unknown", "", full_name
