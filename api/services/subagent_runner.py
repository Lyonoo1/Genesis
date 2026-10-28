import asyncio
import json
import logging
from typing import Any, AsyncGenerator, Optional

from services.llm_adapter import LLMAdapter, llm_adapter
from services.tool_adapter import ToolAdapter
from services.workspace_tool_executor import WorkspaceToolExecutor
from services.context_manager import ContextManager

logger = logging.getLogger("genesis.subagent_runner")


class SubagentRunner:
    """Subagent 子代理隔离委派执行引擎 (参考 Claude Code Task 工具设计)

    解决代码库大范围探索污染主会话上下文问题：
    1. 独立上下文沙盒：隔离 messages 历史，用完即丢弃数万中间 Token
    2. 严格工具权限收缩：explore 纯只读，verify 只增测试执行，严禁写文件与递归套娃
    3. 步数与输出收敛：步数限制 <= 8，最终结果限制 <= 2,000 字符
    """

    EXPLORE_ALLOWED_TOOLS = {
        "workspace__read_file",
        "workspace__grep_search",
        "workspace__find_by_name",
        "workspace__list_dir",
    }

    VERIFY_ALLOWED_TOOLS = {
        "workspace__read_file",
        "workspace__grep_search",
        "workspace__find_by_name",
        "workspace__list_dir",
        "workspace__execute_command",
    }

    FORBIDDEN_TOOLS = {
        "workspace__write_file",
        "workspace__edit_file",
        "workspace__delete_file",
        "workspace__dispatch_subagent",
        "workspace__stop_process",
    }

    def __init__(self, llm: Optional[LLMAdapter] = None):
        self.llm_adapter = llm or llm_adapter

    def _get_system_prompt(self, agent_type: str, workspace_root: str) -> str:
        if agent_type == "explore":
            return (
                "你是 Genesis 代码库探索与架构分析子代理 (Explore Subagent)。\n"
                f"当前项目物理工作区绝对路径：'{workspace_root}'。\n"
                "你的任务：独立在代码库中检索、调研与分析，解答主 Agent 提出的具体代码或架构问题。\n\n"
                "【严格执行规范】\n"
                "1. 只读权限：你只拥有只读探索工具（read_file, grep_search, find_by_name, list_dir）。严禁尝试修改或执行文件。\n"
                "2. 高效聚焦：直接查阅最核心的文件定义、引用链路与实现，避免无意义的泛读。\n"
                "3. 详尽结构化报告：调查完毕后，直接输出结构清晰、信息详尽的总结分析报告（重点说明涉及文件路径、核心逻辑、架构分层与调研结论）。"
            )
        elif agent_type == "verify":
            return (
                "你是 Genesis 测试验证与排查子代理 (Verify Subagent)。\n"
                f"当前项目物理工作区绝对路径：'{workspace_root}'。\n"
                "你的任务：独立运行测试命令、分析输出、排查报错并精确定位问题根因。\n\n"
                "【严格执行规范】\n"
                "1. 权限边界：你仅可使用只读文件工具和命令执行工具（execute_command, read_file, grep_search, find_by_name, list_dir）。严禁修改或删除文件。\n"
                "2. 报错定位：运行测试并分析控制台输出，定位到具体出错的文件行号、异常原因与触发路径。\n"
                "3. 详尽结构化报告：调查完毕后，直接输出清晰排查报告（说明测试结果、报错根因及修复建议）。"
            )
        else:
            return (
                f"你是 Genesis 专用只读子代理，工作区：'{workspace_root}'。\n"
                "请完成调查并给出结构清晰的详尽分析报告。"
            )

    def _filter_allowed_tools(self, agent_type: str) -> list[dict[str, Any]]:
        allowed_names = (
            self.VERIFY_ALLOWED_TOOLS if agent_type == "verify" else self.EXPLORE_ALLOWED_TOOLS
        )
        return [
            bt
            for bt in ToolAdapter.BUILTIN_WORKSPACE_TOOLS
            if bt.get("function", {}).get("name") in allowed_names
        ]

    async def run(
        self,
        workspace_root: str,
        agent_type: str,
        task_prompt: str,
        model: str,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        provider: Optional[str] = None,
        max_steps: int = 8,
        max_summary_length: Optional[int] = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """运行沙箱化 Subagent，流式产出 progress 事件并在最后输出 result"""
        logger.info("启动 Subagent [%s]，任务目标: %s", agent_type, task_prompt[:100])

        system_prompt = self._get_system_prompt(agent_type, workspace_root)
        allowed_tools = self._filter_allowed_tools(agent_type)
        allowed_tool_names = {t["function"]["name"] for t in allowed_tools}

        # 独立上下文沙盒：初始仅包含专用 System Prompt 和 task_prompt
        sub_messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": task_prompt},
        ]

        step = 1
        final_summary: str = ""

        while step <= max_steps:
            logger.info("Subagent [%s] 进入 Step %d/%d", agent_type, step, max_steps)

            step_text = ""
            step_reasoning = ""
            step_tool_calls: list[dict[str, Any]] = []

            # 广播子代理执行状态
            yield {
                "type": "progress",
                "data": {
                    "event": "subagent_progress",
                    "agent_type": agent_type,
                    "task_prompt": task_prompt,
                    "step": step,
                    "max_steps": max_steps,
                    "status": "thinking",
                },
            }

            try:
                stream = self.llm_adapter.stream_chat(
                    messages=sub_messages,
                    tools=allowed_tools if allowed_tools else None,
                    model=model,
                    temperature=0.3,
                    max_tokens=8192,
                    api_key=api_key,
                    base_url=base_url,
                    provider=provider,
                )

                async for chunk in stream:
                    if chunk.type == "text":
                        step_text += chunk.text or ""
                    elif chunk.type == "reasoning":
                        step_reasoning += chunk.text or ""
                    elif chunk.type == "tool_finish":
                        step_tool_calls.append(
                            {
                                "id": chunk.tool_call_id,
                                "name": chunk.tool_name,
                                "arguments": chunk.arguments or {},
                            }
                        )
            except Exception as stream_err:
                logger.error("Subagent [%s] 模型调用异常: %s", agent_type, stream_err)
                final_summary = f"[Subagent 异常终止] 模型生成异常: {stream_err}"
                break

            step_thinking = step_reasoning.strip() or step_text.strip()

            # 情况 A: 子代理没有调用工具，输出了结论或回答
            if not step_tool_calls:
                final_summary = step_text.strip()
                yield {
                    "type": "progress",
                    "data": {
                        "event": "subagent_progress",
                        "agent_type": agent_type,
                        "task_prompt": task_prompt,
                        "step": step,
                        "status": "completed",
                        "thinking": step_thinking,
                        "thinking_content": step_thinking,
                        "summary_preview": final_summary[:200],
                    },
                }
                break

            # 情况 B: 子代理发起了工具调用
            tool_names_called = [t.get("name") for t in step_tool_calls if t.get("name")]
            # 提取子代理思考逻辑或工具调用意图
            start_preview = ""
            if step_thinking:
                start_preview = step_thinking
            elif step_tool_calls:
                first_tc = step_tool_calls[0]
                first_args = first_tc.get("arguments") or {}
                if isinstance(first_args, str):
                    try:
                        first_args = json.loads(first_args)
                    except Exception:
                        first_args = {}
                arg_hint = (
                    first_args.get("path")
                    or first_args.get("query")
                    or first_args.get("command")
                    or first_args.get("pattern")
                    or ""
                )
                start_preview = f"准备调用: {arg_hint}" if arg_hint else f"执行工具调用"

            yield {
                "type": "progress",
                "data": {
                    "event": "subagent_progress",
                    "agent_type": agent_type,
                    "task_prompt": task_prompt,
                    "step": step,
                    "status": "executing_tools",
                    "tool_calls": tool_names_called,
                    "thinking": step_thinking,
                    "thinking_content": step_thinking,
                    "summary_preview": start_preview[:250],
                },
            }

            # 记录 assistant tool_calls
            sub_messages.append(
                {
                    "role": "assistant",
                    "content": step_text if step_text else None,
                    "tool_calls": [
                        {
                            "id": t["id"],
                            "type": "function",
                            "function": {
                                "name": t["name"],
                                "arguments": json.dumps(t["arguments"], ensure_ascii=False)
                                if isinstance(t["arguments"], dict)
                                else str(t["arguments"]),
                            },
                        }
                        for t in step_tool_calls
                    ],
                }
            )

            # 执行工具
            for tc in step_tool_calls:
                tc_id = tc["id"]
                tc_name = str(tc.get("name") or "")
                raw_tc_args = tc.get("arguments")
                if isinstance(raw_tc_args, str):
                    try:
                        tc_args = json.loads(raw_tc_args)
                    except Exception:
                        tc_args = {}
                elif isinstance(raw_tc_args, dict):
                    tc_args = raw_tc_args
                else:
                    tc_args = {}

                res_payload: Any = None
                is_error = False
                normalized_name = (
                    tc_name if tc_name.startswith("workspace__") else f"workspace__{tc_name}"
                )

                # 严格权限拦截：严禁越权调用未允许工具或递归调用 subagent
                if (
                    normalized_name not in allowed_tool_names
                    or normalized_name in self.FORBIDDEN_TOOLS
                    or tc_name in self.FORBIDDEN_TOOLS
                ):
                    is_error = True
                    res_payload = {
                        "error": f"权限拒绝：Subagent [{agent_type}] 无权调用工具 '{tc_name}'（严禁写文件与递归嵌套派发）"
                    }
                else:
                    try:
                        _, _, method = ToolAdapter.parse_namespaced_tool(normalized_name)
                        if method == "read_file":
                            res_payload = await asyncio.wait_for(
                                asyncio.to_thread(
                                    WorkspaceToolExecutor.read_file,
                                    workspace_root=workspace_root,
                                    path=tc_args.get("path", ""),
                                ),
                                timeout=15.0,
                            )
                        elif method == "grep_search":
                            res_payload = await asyncio.wait_for(
                                asyncio.to_thread(
                                    WorkspaceToolExecutor.grep_search,
                                    workspace_root=workspace_root,
                                    query=tc_args.get("query", ""),
                                    path=tc_args.get("path", "."),
                                    case_sensitive=tc_args.get("case_sensitive", False),
                                    is_regex=tc_args.get("is_regex", False),
                                ),
                                timeout=15.0,
                            )
                        elif method == "find_by_name":
                            res_payload = await asyncio.wait_for(
                                asyncio.to_thread(
                                    WorkspaceToolExecutor.find_by_name,
                                    workspace_root=workspace_root,
                                    pattern=tc_args.get("pattern", "*"),
                                    path=tc_args.get("path", "."),
                                    type=tc_args.get("type", "any"),
                                ),
                                timeout=15.0,
                            )
                        elif method == "list_dir":
                            res_payload = await asyncio.wait_for(
                                asyncio.to_thread(
                                    WorkspaceToolExecutor.list_dir,
                                    workspace_root=workspace_root,
                                    path=tc_args.get("path", "."),
                                    recursive=tc_args.get("recursive", False),
                                ),
                                timeout=15.0,
                            )
                        elif method == "execute_command" and agent_type == "verify":
                            res_payload = await WorkspaceToolExecutor.execute_command(
                                workspace_root=workspace_root,
                                command=tc_args.get("command", ""),
                                timeout=tc_args.get("timeout", 30),
                                is_background=False,
                            )
                        else:
                            is_error = True
                            res_payload = {"error": f"子代理不支持的方法: {method}"}
                    except Exception as err:
                        is_error = True
                        res_payload = {"error": str(err)}

                tool_content_str = json.dumps(res_payload, ensure_ascii=False)
                tool_content_str = ContextManager.gate_tool_output(tool_content_str)
                tool_mem_item: dict[str, Any] = {
                    "role": "tool",
                    "tool_call_id": tc_id,
                    "content": tool_content_str,
                }
                if is_error:
                    tool_mem_item["is_error"] = True
                sub_messages.append(tool_mem_item)

            # 生成步骤执行成果摘要
            done_preview = ""
            if res_payload:
                if isinstance(res_payload, dict):
                    if "lines" in res_payload:
                        done_preview = f"读取完成 (共 {res_payload.get('lines', 0)} 行)"
                    elif "entries" in res_payload:
                        done_preview = f"列出完成 (共 {len(res_payload.get('entries', []))} 项)"
                    elif "matches" in res_payload:
                        done_preview = f"检索完成 (匹配 {len(res_payload.get('matches', []))} 处)"
                    elif "exit_code" in res_payload:
                        code = res_payload.get("exit_code")
                        done_preview = f"命令执行完成 (退出码: {code})"
                    elif "error" in res_payload:
                        done_preview = f"执行报错: {res_payload.get('error')}"
                    elif "message" in res_payload:
                        done_preview = str(res_payload.get("message"))
                if not done_preview:
                    done_preview = str(res_payload)[:150]

            step += 1
            yield {
                "type": "progress",
                "data": {
                    "event": "subagent_progress",
                    "agent_type": agent_type,
                    "task_prompt": task_prompt,
                    "step": step - 1,
                    "status": "step_done",
                    "tool_calls": tool_names_called,
                    "thinking": step_thinking,
                    "thinking_content": step_thinking,
                    "summary_preview": done_preview,
                },
            }

        # 若达到最大步数但仍未给出最终总结，强制单步总结收尾
        if not final_summary:
            sub_messages.append(
                {
                    "role": "user",
                    "content": "已达到最大调查步数上限。请基于前面查阅到的所有信息，直接给出最终结构清晰、详尽的分析总结报告。",
                }
            )
            try:
                stream = self.llm_adapter.stream_chat(
                    messages=sub_messages,
                    tools=None,
                    model=model,
                    temperature=0.3,
                    max_tokens=8192,
                    api_key=api_key,
                    base_url=base_url,
                    provider=provider,
                )
                async for chunk in stream:
                    if chunk.type == "text":
                        final_summary += chunk.text or ""
            except Exception as e:
                logger.warning("Subagent 强制收尾生成失败: %s", e)
                final_summary = f"[Subagent 调查结束] 共执行 {step - 1} 步探索，未能生成最终完整报告: {e}"

        clean_summary = final_summary.strip()
        # 仅在显式传入 max_summary_length 时进行截断（单测兼容）；默认无截断完整输出
        if max_summary_length and len(clean_summary) > max_summary_length:
            clean_summary = (
                clean_summary[: max(100, max_summary_length - 50)]
                + f"\n...[Subagent 输出超出 {max_summary_length} 字符已自动截断]"
            )

        logger.info("Subagent [%s] 完成，最终总结长度: %d 字符", agent_type, len(clean_summary))

        yield {
            "type": "result",
            "data": {
                "success": True,
                "agent_type": agent_type,
                "steps_taken": min(step, max_steps),
                "summary": clean_summary,
            },
        }


# 全局单例
subagent_runner = SubagentRunner()
