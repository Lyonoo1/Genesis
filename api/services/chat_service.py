import asyncio
import json
import logging
import time
from typing import Any, AsyncGenerator, Optional
from uuid import UUID

from core.exceptions import AppException, ErrorCode
from models.schemas.chat import SSEEventName, ChatRequest
from models.schemas.message import MessageCreate, MessageRole, MessageStatus, ToolCallItem
from models.schemas.session import SessionUpdate
from repositories.message_repository import MessageRepository
from repositories.session_repository import SessionRepository
from repositories.mcp_repository import McpRepository
from repositories.skill_repository import SkillRepository
from services.context_manager import ContextManager, context_manager
from services.llm_adapter import LLMAdapter, llm_adapter, StreamChunk
from services.mcp_client import McpClientManager, mcp_client_manager
from services.skill_engine import SkillEngine, skill_engine
from services.tool_adapter import ToolAdapter

logger = logging.getLogger("genesis.chat_service")

# 全局正在运行的生成任务注册表: "{user_id}:{session_id}" -> asyncio.Task
RUNNING_TASKS: dict[str, asyncio.Task] = {}


def format_sse(event: str, data: dict[str, Any]) -> str:
    """按 W3C 标准格式化 SSE 消息报文"""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# 类似 Claude 架构的轻量模型旁路分流映射表 (避免主模型/思考模型产生高额延迟和成本)
FAST_TITLE_MODEL_MAPPING: dict[str, str] = {
    "deepseek-reasoner": "deepseek-chat",
    "deepseek-r1": "deepseek-chat",
    "deepseek-flash": "deepseek-chat",
    "o1": "gpt-4o-mini",
    "o1-mini": "gpt-4o-mini",
    "o3-mini": "gpt-4o-mini",
    "gpt-4o": "gpt-4o-mini",
    "claude-3-7-sonnet": "claude-3-5-haiku",
    "claude-3-5-sonnet": "claude-3-5-haiku",
    "claude-3-opus": "claude-3-haiku",
}


class ChatService:
    """Agent ReAct Loop 核心编排引擎：驱动多步 Tool Calling、沙箱与 MCP 执行及流式推送"""

    def __init__(
        self,
        message_repo: Optional[MessageRepository] = None,
        session_repo: Optional[SessionRepository] = None,
        skill_repo: Optional[SkillRepository] = None,
        mcp_repo: Optional[McpRepository] = None,
        engine: Optional[SkillEngine] = None,
        mcp_manager: Optional[McpClientManager] = None,
        llm: Optional[LLMAdapter] = None,
        ctx_mgr: Optional[ContextManager] = None,
    ):
        self.message_repo = message_repo or MessageRepository()
        self.session_repo = session_repo or SessionRepository()
        self.skill_repo = skill_repo or SkillRepository()
        self.mcp_repo = mcp_repo or McpRepository()
        self.skill_engine = engine or skill_engine
        self.mcp_client_manager = mcp_manager or mcp_client_manager
        self.llm_adapter = llm or llm_adapter
        self.context_manager = ctx_mgr or context_manager

    @staticmethod
    def _task_key(user_id: str, session_id: Any) -> str:
        return f"{user_id}:{session_id}"

    def register_task(self, user_id: str, session_id: Any, task: asyncio.Task) -> None:
        key = self._task_key(user_id, session_id)
        RUNNING_TASKS[key] = task

    def unregister_task(self, user_id: str, session_id: Any) -> None:
        key = self._task_key(user_id, session_id)
        RUNNING_TASKS.pop(key, None)

    def stop_task(self, user_id: str, session_id: Any) -> bool:
        """秒级 cancel 当前会话运行中的 Task"""
        key = self._task_key(user_id, session_id)
        task = RUNNING_TASKS.get(key)
        if task and not task.done():
            task.cancel()
            self.unregister_task(user_id, session_id)
            logger.info("已成功取消会话 [%s] 正在运行的生成任务", session_id)
            return True
        return False

    async def collect_tools(self, user_id: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """收集当前用户所有可用的 Standard Tools，并建立反向查询元数据索引"""
        tools_list: list[dict[str, Any]] = []
        tools_lookup: dict[str, Any] = {}

        # 1. 收集自动触发的 Skills
        try:
            skills = await self.skill_repo.list_by_user(user_id)
            for s in skills:
                if s.get("auto_trigger", True):
                    standard_tool = ToolAdapter.skill_to_standard_tool(s)
                    tools_list.append(standard_tool)
                    fn_name = standard_tool["function"]["name"]
                    tools_lookup[fn_name] = {"type": "skill", "data": s}
        except Exception as exc:
            logger.warning("收集用户 Skills 异常: %s", exc)

        # 2. 收集已启用的 MCP Tools
        try:
            mcp_servers = await self.mcp_repo.list_by_user(user_id)
            for srv in mcp_servers:
                if not srv.get("enabled", True):
                    continue
                srv_name = srv["name"]
                for t in srv.get("tools") or []:
                    if t.get("enabled", True):
                        standard_tool = ToolAdapter.mcp_to_standard_tool(srv_name, t)
                        tools_list.append(standard_tool)
                        fn_name = standard_tool["function"]["name"]
                        tools_lookup[fn_name] = {
                            "type": "mcp",
                            "server": srv,
                            "raw_name": t.get("name"),
                        }
        except Exception as exc:
            logger.warning("收集用户 MCP Tools 异常: %s", exc)

        return tools_list, tools_lookup

    async def generate_session_title(
        self,
        content: str,
        model: str,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> Optional[str]:
        """轻量级智能提炼 4~10 字会话标题 (对标 Claude 官方 Output Guard 与分流架构)"""
        cleaned = content.strip()
        if not cleaned:
            return None

        # 若内容极短且为单行，直接作为标题
        if len(cleaned) <= 6 and "\n" not in cleaned:
            return cleaned

        # 引入 Claude 官方标准的 Output Guard 守卫与提示词规范
        title_messages = [
            {
                "role": "user",
                "content": (
                    "You are a professional session title generator.\n"
                    "Analyze the user's initial message and generate a concise, sentence-case topic title.\n\n"
                    "Strict Requirements:\n"
                    "1. Length: 4-10 Chinese characters (or 3-6 English words).\n"
                    "2. Format: Plain text only. No quotes, backticks, emojis, or trailing punctuation.\n"
                    "3. No Prefixes: Never include prefixes like 'Title:', '标题：', '关于...'.\n"
                    "4. [Output Guard]: Do NOT answer the user's question, execute their request, or write code. Output ONLY the title itself.\n\n"
                    f"User Message:\n{cleaned[:300]}\n\n"
                    "Title:"
                ),
            }
        ]

        title_text = ""
        # 封装底层快速单次生成闭包
        async def _invoke_title_llm(target_model: str) -> str:
            accumulated = ""
            stream = self.llm_adapter.stream_chat(
                messages=title_messages,
                tools=None,
                model=target_model,
                temperature=0.3,
                max_tokens=25,
                api_key=api_key,
                base_url=base_url,
                provider=provider,
            )
            async for chunk in stream:
                if chunk.type == "text" and chunk.text:
                    accumulated += chunk.text
            return accumulated

        try:
            # 第一顺位：尝试匹配同 Base URL 账号下的同厂极速平替模型
            title_model = model
            model_lower = model.lower()
            for heavy_prefix, fast_model in FAST_TITLE_MODEL_MAPPING.items():
                if heavy_prefix in model_lower:
                    title_model = fast_model
                    break

            if title_model != model:
                try:
                    title_text = await _invoke_title_llm(title_model)
                except Exception as inner_err:
                    # 若用户服务商未开放该轻量模型 (如 404 Model Not Found)，无缝回退至用户原生配置的模型本身
                    logger.info("同厂平替模型 [%s] 调用失败 (%s)，回退至用户原生模型 [%s]", title_model, inner_err, model)
                    title_text = await _invoke_title_llm(model)
            else:
                # 若无映射或已是原生模型，直接调用用户配置的模型
                title_text = await _invoke_title_llm(model)

            # 清理标点、代码符号与多余前缀
            title = (
                title_text.strip()
                .replace("\n", "")
                .replace("`", "")
                .replace('"', "")
                .replace("'", "")
                .replace("《", "")
                .replace("》", "")
                .replace("“", "")
                .replace("”", "")
            )
            for prefix in ["Title:", "title:", "标题：", "标题:", "主题：", "主题:"]:
                if title.startswith(prefix):
                    title = title[len(prefix):].strip()

            # 去除末尾句号或冒号
            title = title.rstrip(".。:：")

            if title and len(title) > 0:
                return title[:16]
        except Exception as e:
            logger.warning("智能提取标题异常，采用文本截断降级: %s", e)

        return cleaned[:10]

    async def handle_stream(
        self,
        session_id: Any,
        req: ChatRequest,
        user_id: str,
        max_steps: int = 5,
    ) -> AsyncGenerator[str, None]:
        """核心 ReAct 流式生成器：协调持久化、模型推理与多步工具执行"""
        current_task = asyncio.current_task()
        if current_task:
            self.register_task(user_id, session_id, current_task)

        # 1. 持久化当前用户消息
        user_msg = await self.message_repo.create(
            user_id=user_id,
            msg_in=MessageCreate(
                session_id=session_id,
                parent_id=req.parent_id,
                role=MessageRole.USER,
                content=req.content,
                status=MessageStatus.SUCCESS,
            ),
        )
        last_message_id = user_msg["id"]
        run_t0 = time.time()
        # 广播前端会话初始化事件
        yield format_sse(
            "session_info",
            {"session_id": str(session_id), "model": req.model},
        )

        # 1.1 异步标题提炼机制：若当前会话为默认的“新对话”，后台异步启动标题提取并自动持久化
        title_task: Optional[asyncio.Task] = None
        try:
            sess = await self.session_repo.get_by_id(user_id, session_id)
            if sess and (not sess.get("title") or sess.get("title") == "新对话"):
                async def _title_worker():
                    try:
                        generated = await self.generate_session_title(
                            content=req.content,
                            model=req.model,
                            api_key=req.api_key,
                            base_url=req.base_url,
                            provider=req.provider,
                        )
                        if generated:
                            curr = await self.session_repo.get_by_id(user_id, session_id)
                            if curr and (not curr.get("title") or curr.get("title") == "新对话"):
                                await self.session_repo.update(user_id, session_id, SessionUpdate(title=generated))
                                logger.info("会话 [%s] 标题已智能更新为: %s", session_id, generated)
                                return generated
                    except Exception as err:
                        logger.warning("异步提炼标题失败: %s", err)
                    return None

                title_task = asyncio.create_task(_title_worker())
        except Exception as e:
            logger.warning("检查会话标题状态异常: %s", e)

        total_input_tokens = 0
        total_output_tokens = 0

        try:
            # 2. 构建初始上下文与动态工具装配
            available_tools, tools_lookup = await self.collect_tools(user_id)
            messages = await self.context_manager.build_context(
                user_id=user_id,
                session_id=session_id,
                new_prompt=req.content,
                parent_id=req.parent_id,
                model=req.model,
                has_tools=bool(available_tools),
                context_window=req.context_window or 1048576,
            )

            step = 1

            # 3. 进入 ReAct 循环
            while step <= max_steps:
                logger.info("会话 [%s] 进入 ReAct Step %d", session_id, step)

                step_text = ""
                step_reasoning = ""
                step_tool_calls: list[dict[str, Any]] = []

                # 调用底层流式适配器 (支持用户自定义 API Key 与 Base URL)
                stream = self.llm_adapter.stream_chat(
                    messages=messages,
                    tools=available_tools if available_tools else None,
                    model=req.model,
                    temperature=req.temperature or 0.7,
                    max_tokens=req.max_tokens,
                    api_key=req.api_key,
                    base_url=req.base_url,
                    provider=req.provider,
                )

                finish_reason = "stop"
                async for chunk in stream:
                    if chunk.type == "text":
                        step_text += chunk.text or ""
                        yield format_sse(
                            SSEEventName.TEXT_DELTA.value,
                            {"delta": chunk.text, "step": step},
                        )
                    elif chunk.type == "reasoning":
                        step_reasoning += chunk.text or ""
                        yield format_sse(
                            SSEEventName.REASONING_DELTA.value,
                            {"delta": chunk.text, "step": step},
                        )
                    elif chunk.type == "tool_start":
                        yield format_sse(
                            SSEEventName.TOOL_CALL_START.value,
                            {
                                "tool_call_id": chunk.tool_call_id,
                                "name": chunk.tool_name,
                                "step": step,
                            },
                        )
                    elif chunk.type == "tool_delta":
                        yield format_sse(
                            SSEEventName.TOOL_CALL_DELTA.value,
                            {
                                "tool_call_id": chunk.tool_call_id,
                                "delta": chunk.text,
                                "step": step,
                            },
                        )
                    elif chunk.type == "tool_finish":
                        step_tool_calls.append(
                            {
                                "id": chunk.tool_call_id,
                                "name": chunk.tool_name,
                                "arguments": chunk.arguments or {},
                            }
                        )
                    elif chunk.type == "finish":
                        finish_reason = chunk.finish_reason or "stop"
                        total_input_tokens += chunk.input_tokens
                        total_output_tokens += chunk.output_tokens

                # 情况 A：模型无工具调用，直接输出最终回复
                if not step_tool_calls:
                    # Claude 式无感自动断点接力续写 (Auto-Continue Loop)
                    auto_continue_round = 0
                    max_auto_continue = 3

                    while finish_reason == "length" and auto_continue_round < max_auto_continue:
                        auto_continue_round += 1
                        logger.info(
                            "会话 [%s] 触发 Claude 式无感自动接力续写 (第 %d/%d 轮)",
                            session_id,
                            auto_continue_round,
                            max_auto_continue,
                        )

                        continue_messages = list(messages)
                        if step_text:
                            continue_messages.append({"role": "assistant", "content": step_text})
                            continue_messages.append(
                                {
                                    "role": "user",
                                    "content": "你的回复因达到单次输出上限被截断，请紧接着上一句截断处直接继续输出后面的内容或代码，严禁重复前面已有文字。",
                                }
                            )
                        elif step_reasoning:
                            continue_messages.append(
                                {
                                    "role": "user",
                                    "content": "思考推导已充分，请立即直接输出最终完整的代码或答复正文，不要再进行冗长思考推演。",
                                }
                            )
                        else:
                            break

                        continue_stream = self.llm_adapter.stream_chat(
                            messages=continue_messages,
                            tools=None,
                            model=req.model,
                            temperature=req.temperature or 0.7,
                            max_tokens=req.max_tokens,
                            api_key=req.api_key,
                            base_url=req.base_url,
                            provider=req.provider,
                        )

                        finish_reason = "stop"
                        async for c in continue_stream:
                            if c.type == "text":
                                step_text += c.text or ""
                                yield format_sse(
                                    SSEEventName.TEXT_DELTA.value,
                                    {"delta": c.text, "step": step},
                                )
                            elif c.type == "reasoning":
                                step_reasoning += c.text or ""
                                yield format_sse(
                                    SSEEventName.REASONING_DELTA.value,
                                    {"delta": c.text, "step": step},
                                )
                            elif c.type == "finish":
                                finish_reason = c.finish_reason or "stop"
                                total_input_tokens += c.input_tokens
                                total_output_tokens += c.output_tokens

                    final_content = step_text
                    if not final_content:
                        if finish_reason == "length":
                            final_content = "⚠️ **[生成截断]** 模型的深度思考已多次耗尽配额未能输出正文。已保留上方思考过程，建议调大上下文或提示模型精简推导。"
                        elif step_reasoning:
                            final_content = step_reasoning

                        # 向前端实时广播兜底正文，防止页面渲染为空白
                        if final_content:
                            yield format_sse(
                                SSEEventName.TEXT_DELTA.value,
                                {"delta": final_content, "step": step},
                            )

                    assistant_msg = await self.message_repo.create(
                        user_id=user_id,
                        msg_in=MessageCreate(
                            session_id=session_id,
                            parent_id=last_message_id,
                            role=MessageRole.ASSISTANT,
                            content=final_content,
                            reasoning_content=step_reasoning if step_reasoning else None,
                            status=MessageStatus.SUCCESS,
                        ),
                    )
                    last_message_id = assistant_msg["id"]
                    yield format_sse(
                        SSEEventName.STEP_FINISH.value,
                        {"step": step, "finish_reason": finish_reason},
                    )

                    # 智能标题生成就绪广播
                    if title_task:
                        try:
                            if title_task.done():
                                gen_title = title_task.result()
                            else:
                                gen_title = await asyncio.wait_for(asyncio.shield(title_task), timeout=0.8)
                            if gen_title:
                                yield format_sse(
                                    SSEEventName.SESSION_TITLE_UPDATED.value,
                                    {"session_id": str(session_id), "title": gen_title},
                                )
                        except Exception:
                            pass
                        title_task = None

                    break

                # 情况 B：模型触发了工具调用，执行多态工具派发
                # 1. 组装并保存 assistant 提出的工具调用指令消息
                tool_items = [
                    ToolCallItem(id=t["id"], name=t["name"], args=t["arguments"])
                    for t in step_tool_calls
                ]
                assistant_tool_msg = await self.message_repo.create(
                    user_id=user_id,
                    msg_in=MessageCreate(
                        session_id=session_id,
                        parent_id=last_message_id,
                        role=MessageRole.ASSISTANT,
                        content=step_text if step_text else None,
                        raw_tool_calls=tool_items,
                        status=MessageStatus.SUCCESS,
                    ),
                )
                last_message_id = assistant_tool_msg["id"]

                # 2. 将 Assistant 带有 tool_calls 的消息写回内存上下文
                messages.append(
                    {
                        "role": "assistant",
                        "content": step_text if step_text else None,
                        "tool_calls": [
                            {
                                "id": t["id"],
                                "type": "function",
                                "function": {
                                    "name": t["name"],
                                    "arguments": json.dumps(t["arguments"]),
                                },
                            }
                            for t in step_tool_calls
                        ],
                    }
                )

                # 3. 执行工具并广播结果
                for tc in step_tool_calls:
                    tc_id = tc["id"]
                    tc_name = tc["name"]
                    tc_args = tc["arguments"]

                    tool_meta = tools_lookup.get(tc_name)
                    res_payload: Any = None
                    is_error = False

                    try:
                        if not tool_meta:
                            # 尝试兜底反向命名空间解析
                            kind, target, method = ToolAdapter.parse_namespaced_tool(tc_name)
                            if kind == "skill":
                                skill_obj = None
                                try:
                                    skill_obj = await self.skill_repo.get_by_name(user_id, target)
                                except Exception:
                                    pass
                                if not skill_obj:
                                    skill_obj = {"id": target, "name": target}
                                tool_meta = {"type": "skill", "data": skill_obj}
                            elif kind == "mcp":
                                srv_obj = None
                                try:
                                    srv_obj = await self.mcp_repo.get_by_name(user_id, target)
                                except Exception:
                                    pass
                                if not srv_obj:
                                    srv_obj = {"name": target}
                                tool_meta = {
                                    "type": "mcp",
                                    "server": srv_obj,
                                    "raw_name": method,
                                }
                            else:
                                raise AppException(
                                    code=ErrorCode.NOT_FOUND,
                                    message=f"未找到工具 [{tc_name}] 的执行器配置",
                                )

                        if tool_meta.get("type") == "skill":
                            skill_data = tool_meta["data"]
                            res_payload = await self.skill_engine.execute_skill(
                                skill=skill_data,
                                arguments=tc_args,
                                timeout=30,
                            )
                        elif tool_meta.get("type") == "mcp":
                            server_data = tool_meta["server"]
                            raw_name = tool_meta["raw_name"]
                            res_payload = await self.mcp_client_manager.call_tool(
                                config=server_data,
                                tool_name=raw_name,
                                arguments=tc_args,
                            )
                        else:
                            raise AppException(
                                code=ErrorCode.NOT_FOUND,
                                message=f"未支持的工具类型: {tc_name}",
                            )
                    except Exception as exc:
                        is_error = True
                        res_payload = {"error": str(exc)}
                        logger.error("执行工具 [%s] 失败: %s", tc_name, exc)

                    # 广播工具执行结果事件
                    yield format_sse(
                        SSEEventName.TOOL_CALL_RESULT.value,
                        {
                            "tool_call_id": tc_id,
                            "name": tc_name,
                            "result": res_payload,
                            "is_error": is_error,
                            "step": step,
                        },
                    )

                    # 持久化 tool 角色消息入库
                    tool_content_str = json.dumps(res_payload, ensure_ascii=False)
                    tool_msg_record = await self.message_repo.create(
                        user_id=user_id,
                        msg_in=MessageCreate(
                            session_id=session_id,
                            parent_id=last_message_id,
                            role=MessageRole.TOOL,
                            content=tool_content_str,
                            tool_call_id=tc_id,
                            status=MessageStatus.SUCCESS if not is_error else MessageStatus.FAILED,
                        ),
                    )
                    last_message_id = tool_msg_record["id"]

                    # 写回 messages 供下一步模型上下文使用
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc_id,
                            "content": tool_content_str,
                        }
                    )

                yield format_sse(
                    SSEEventName.STEP_FINISH.value,
                    {"step": step, "finish_reason": "tool_calls"},
                )

                step += 1
                if step > max_steps:
                    # 触发安全熔断保护
                    warn_text = f"\n\n[Genesis 提示: 已达到单轮对话 ReAct 最大步数上限 {max_steps}，自动终止以防死循环]"
                    yield format_sse(
                        SSEEventName.TEXT_DELTA.value,
                        {"delta": warn_text, "step": step - 1},
                    )
                    break

            # 最终收尾如果还有未推送的 title_task
            if title_task:
                try:
                    if title_task.done():
                        gen_title = title_task.result()
                    else:
                        gen_title = await asyncio.wait_for(asyncio.shield(title_task), timeout=0.8)
                    if gen_title:
                        yield format_sse(
                            SSEEventName.SESSION_TITLE_UPDATED.value,
                            {"session_id": str(session_id), "title": gen_title},
                        )
                except Exception:
                    pass
                title_task = None

            # 4. 广播全流程完成事件
            yield format_sse(
                SSEEventName.DONE.value,
                {
                    "session_id": str(session_id),
                    "last_message_id": str(last_message_id),
                    "total_steps": step if step <= max_steps else max_steps,
                    "tokens": {
                        "input": total_input_tokens,
                        "output": total_output_tokens,
                    },
                },
            )

        except asyncio.CancelledError:
            logger.info("会话 [%s] 生成任务被客户端主动中止", session_id)
            yield format_sse(
                SSEEventName.ERROR.value,
                {"code": "TASK_CANCELLED", "message": "生成任务已被中止"},
            )
        except AppException as exc:
            logger.error("会话 [%s] 业务异常: %s", session_id, exc.message)
            yield format_sse(
                SSEEventName.ERROR.value,
                {"code": exc.code.value, "message": exc.message},
            )
        except Exception as exc:
            logger.exception("会话 [%s] 发生未知异常: %s", session_id, exc)
            yield format_sse(
                SSEEventName.ERROR.value,
                {"code": "INTERNAL_ERROR", "message": str(exc)},
            )
        finally:
            self.unregister_task(user_id, session_id)
            if total_input_tokens > 0 or total_output_tokens > 0:
                try:
                    from services.usage_service import usage_service
                    await usage_service.log_turn_usage(
                        user_id=user_id,
                        session_id=session_id,
                        model=req.model,
                        input_tokens=total_input_tokens,
                        output_tokens=total_output_tokens,
                    )
                except Exception as exc:
                    logger.warning("审计写入用量失败: %s", exc)



# 全局单例
chat_service = ChatService()
