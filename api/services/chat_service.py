import asyncio
import json
import logging
import os
import re
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
from repositories.project_repository import ProjectRepository
from services.context_manager import ContextManager, context_manager
from services.llm_adapter import LLMAdapter, llm_adapter, StreamChunk
from services.mcp_client import McpClientManager, mcp_client_manager
from services.permission_manager import PermissionDecision, permission_manager
from services.skill_engine import SkillEngine, skill_engine
from services.terminal_manager import get_default_workspace
from services.tool_adapter import ToolAdapter
from services.workspace_tool_executor import WorkspaceToolExecutor

logger = logging.getLogger("genesis.chat_service")

# Codex 范式：纯日常问候门控正则
GREETING_PATTERN = re.compile(
    r"^(你好[啊呀嘛呢]?|您好|hi|hello|hey|在吗|在么|早|早安|晚安|哈喽|早上好|下午好|晚上好)[\s!！。.~?？]*$",
    re.IGNORECASE,
)

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
        project_repo: Optional[ProjectRepository] = None,
        engine: Optional[SkillEngine] = None,
        mcp_manager: Optional[McpClientManager] = None,
        llm: Optional[LLMAdapter] = None,
        ctx_mgr: Optional[ContextManager] = None,
    ):
        self.message_repo = message_repo or MessageRepository()
        self.session_repo = session_repo or SessionRepository()
        self.skill_repo = skill_repo or SkillRepository()
        self.mcp_repo = mcp_repo or McpRepository()
        self.project_repo = project_repo or ProjectRepository()
        self.skill_engine = engine or skill_engine
        self.mcp_client_manager = mcp_manager or mcp_client_manager
        self.llm_adapter = llm or llm_adapter
        self.context_manager = ctx_mgr or context_manager
        self._steering_queues: dict[str, asyncio.Queue[str]] = {}
        self._subagent_semaphore: Optional[asyncio.Semaphore] = None

    @property
    def subagent_semaphore(self) -> asyncio.Semaphore:
        """全局并发子代理信号量，限制单机同时运行的最大子代理数为 2"""
        if self._subagent_semaphore is None:
            self._subagent_semaphore = asyncio.Semaphore(2)
        return self._subagent_semaphore

    @staticmethod
    def _task_key(user_id: str, session_id: Any) -> str:
        return f"{user_id}:{session_id}"

    def register_task(self, user_id: str, session_id: Any, task: asyncio.Task) -> None:
        key = self._task_key(user_id, session_id)
        RUNNING_TASKS[key] = task

    def unregister_task(self, user_id: str, session_id: Any) -> None:
        key = self._task_key(user_id, session_id)
        RUNNING_TASKS.pop(key, None)

    def is_task_running(self, user_id: str, session_id: Any) -> bool:
        """检查指定会话当前是否处于活动运行中状态"""
        key = self._task_key(user_id, session_id)
        task = RUNNING_TASKS.get(key)
        return bool(task and not task.done())

    def add_steering_message(self, user_id: str, session_id: Any, text: str) -> bool:
        """向正在运行中的会话投递实时插话指令 (Mid-task Steering)"""
        key = self._task_key(user_id, session_id)
        q = self._steering_queues.get(key)
        if q is not None and self.is_task_running(user_id, session_id):
            q.put_nowait(text)
            logger.info("会话 [%s] 成功加入实时插话指令: %s", session_id, text[:60])
            return True
        logger.warning("会话 [%s] 当前无正在运行的任务或插话队列不可用", session_id)
        return False

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

    async def resolve_workspace_root(
        self,
        user_id: str,
        session_id: Any = None,
        explicit_path: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> str:
        """多级解析当前会话对应的真实物理工作区绝对路径"""
        # 0. 优先检测当前用户是否已建立本地 Bridge 反向隧道
        from services.bridge_manager import BridgeManager
        bridge = BridgeManager.get_instance()
        if bridge.is_connected(str(user_id)):
            meta = bridge.get_metadata(str(user_id)) or {}
            cwd = meta.get("cwd") or "."
            return f"bridge://{user_id}::{cwd}"

        if explicit_path and os.path.isdir(explicit_path):
            return os.path.abspath(explicit_path)

        # 尝试通过 session / project 反查项目名称与关联文件夹
        project_name: Optional[str] = None
        project_folder: Optional[str] = None
        try:
            target_project_id = project_id
            if session_id:
                sess = await self.session_repo.get_by_id(user_id, session_id)
                if sess and sess.get("project_id"):
                    target_project_id = sess["project_id"]
            if target_project_id:
                proj = await self.project_repo.get_by_id(user_id, target_project_id)
                if proj:
                    project_name = proj.get("name")
                    project_folder = proj.get("folder_path") or proj.get("folder_name")
        except Exception as e:
            logger.warning("查询 Session/Project 关联异常: %s", e)

        # 若项目已明确绑定了本地存在的绝对目录路径，最高优先级命中
        for candidate_name in [project_folder, project_name]:
            if candidate_name and os.path.isabs(candidate_name) and os.path.isdir(candidate_name):
                return os.path.abspath(candidate_name)

        # 环境变量次之 (作为未指定项目路径时的默认备用根目录)
        env_root = os.environ.get("WORKSPACE_ROOT")
        if env_root and os.path.isdir(env_root):
            return os.path.abspath(env_root)

        # 针对常见 Docker 容器化部署路径检查 (/app)
        if os.path.isdir("/app") and os.path.exists("/app/api"):
            if project_folder and os.path.isdir(os.path.join("/app", project_folder)):
                return os.path.join("/app", project_folder)
            return "/app"

        current_file = os.path.abspath(__file__)
        # api/services/chat_service.py -> api -> Genesis
        genesis_root = os.path.abspath(os.path.join(current_file, "..", "..", ".."))
        parent_dir = os.path.abspath(os.path.join(genesis_root, ".."))

        system_roots = {"/", "/root", "/home", "/var", "/etc", "/usr", "/tmp", "/bin", "/opt", "/lib", "Desktop", "Users"}
        is_safe_parent = (
            os.path.isdir(parent_dir)
            and parent_dir != "/"
            and os.path.basename(parent_dir) not in system_roots
        )

        # 如果项目关联了文件夹名或路径
        for candidate_name in [project_folder, project_name]:
            if not candidate_name:
                continue
            if os.path.isabs(candidate_name) and os.path.isdir(candidate_name):
                return candidate_name
            if is_safe_parent:
                if os.path.basename(parent_dir).lower() == candidate_name.lower():
                    return parent_dir
                cand = os.path.join(parent_dir, candidate_name)
                if os.path.isdir(cand):
                    return cand
            if os.path.isdir(genesis_root):
                if os.path.basename(genesis_root).lower() == candidate_name.lower():
                    return genesis_root
                cand = os.path.join(genesis_root, candidate_name)
                if os.path.isdir(cand):
                    return cand

        # 默认回退至安全父目录或 genesis_root
        if is_safe_parent:
            return parent_dir

        if os.path.isdir(genesis_root) and genesis_root != "/":
            return genesis_root

        cwd = os.getcwd()
        if cwd != "/":
            return cwd

        return "/app" if os.path.isdir("/app") else genesis_root

    async def collect_tools(self, user_id: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """收集当前用户所有可用的 Standard Tools，并建立反向查询元数据索引"""
        tools_list: list[dict[str, Any]] = []
        tools_lookup: dict[str, Any] = {}

        # 0. 注入系统内置工作区文件与命令操作工具
        for bt in ToolAdapter.BUILTIN_WORKSPACE_TOOLS:
            tools_list.append(bt)
            fn_name = bt["function"]["name"]
            tools_lookup[fn_name] = {"type": "workspace", "data": bt}

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
        max_steps: int = 20,
    ) -> AsyncGenerator[str, None]:
        """核心 ReAct 流式生成器：协调持久化、模型推理与多步工具执行"""
        current_task = asyncio.current_task()
        if current_task:
            self.register_task(user_id, session_id, current_task)

        task_key = self._task_key(user_id, session_id)
        steering_queue: asyncio.Queue[str] = asyncio.Queue()
        self._steering_queues[task_key] = steering_queue

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
            workspace_root = await self.resolve_workspace_root(
                user_id=user_id,
                session_id=session_id,
                explicit_path=req.workspace_path,
            )
            available_tools, tools_lookup = await self.collect_tools(user_id)
            messages = await self.context_manager.build_context(
                user_id=user_id,
                session_id=session_id,
                new_prompt=req.content,
                parent_id=req.parent_id,
                model=req.model,
                has_tools=bool(available_tools),
                context_window=req.context_window or 1048576,
                workspace_root=workspace_root,
                api_key=req.api_key,
                base_url=req.base_url,
                provider=req.provider,
            )

            # Codex 范式：纯日常问候门控检测
            # 严格禁止在问候时动态删除 tools 列表，确保 System Prompt + Tools 静态前缀稳定以最大化 Prompt Cache 命中率
            is_greeting = bool(GREETING_PATTERN.match(req.content.strip()))
            if is_greeting and messages and messages[-1].get("role") == "user":
                last_user_content = messages[-1].get("content") or ""
                hint = "\n[系统提示: 该消息为常规问候，请直接回复，无需调用任何工具]"
                if isinstance(last_user_content, str):
                    if hint not in last_user_content:
                        messages[-1]["content"] = last_user_content + hint
                elif isinstance(last_user_content, list):
                    found_text = False
                    for b in reversed(last_user_content):
                        if isinstance(b, dict) and b.get("type") == "text":
                            if hint not in b.get("text", ""):
                                b["text"] = b.get("text", "") + hint
                            found_text = True
                            break
                    if not found_text:
                        last_user_content.append({"type": "text", "text": hint.strip()})

            step = 1

            # 3. 进入 ReAct 循环
            while step <= max_steps:
                logger.info("会话 [%s] 进入 ReAct Step %d", session_id, step)

                step_text = ""
                step_reasoning = ""
                step_tool_calls: list[dict[str, Any]] = []

                # 保持 tools 静态前缀永不动态清除
                effective_tools = available_tools if available_tools else None

                # 调用底层流式适配器 (支持用户自定义 API Key 与 Base URL)
                stream = self.llm_adapter.stream_chat(
                    messages=messages,
                    tools=effective_tools,
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

                    # 检查运行中实时插话队列 (Mid-task Steering)
                    steered_texts: list[str] = []
                    while not steering_queue.empty():
                        try:
                            st = steering_queue.get_nowait()
                            if st and str(st).strip():
                                steered_texts.append(str(st).strip())
                        except asyncio.QueueEmpty:
                            break

                    if steered_texts:
                        combined_steer = "\n\n".join(steered_texts)
                        logger.info("会话 [%s] 在 Step %d (文本回复结束) 检测到实时插话: %s", session_id, step, combined_steer)
                        steer_msg = await self.message_repo.create(
                            user_id=user_id,
                            msg_in=MessageCreate(
                                session_id=session_id,
                                parent_id=last_message_id,
                                role=MessageRole.USER,
                                content=combined_steer,
                                status=MessageStatus.SUCCESS,
                            ),
                        )
                        last_message_id = steer_msg["id"]
                        asst_text = final_content or step_reasoning or "已完成当前步骤。"
                        messages.append({"role": "assistant", "content": asst_text})
                        messages.append({"role": "user", "content": combined_steer})
                        yield format_sse(
                            SSEEventName.MID_TASK_STEERED.value,
                            {
                                "session_id": str(session_id),
                                "content": combined_steer,
                                "step": step,
                            },
                        )
                        step += 1
                        if step <= max_steps:
                            continue

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
                # ── 并发优化：分拣 subagent 调用与普通工具调用 ──
                normal_tool_calls = []
                subagent_tool_calls = []
                for tc in step_tool_calls:
                    _kind, _target, _method = ToolAdapter.parse_namespaced_tool(tc["name"])
                    if _kind == "workspace" and _method == "dispatch_subagent":
                        subagent_tool_calls.append(tc)
                    else:
                        normal_tool_calls.append(tc)

                # ── 3a. 串行执行普通工具（保持原有逻辑不变）──
                for tc in normal_tool_calls:
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
                            if kind == "workspace":
                                tool_meta = {"type": "workspace", "method": method}
                            elif kind == "skill":
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

                        if res_payload is None and not is_error:
                            # 0. Claude Code (s03) 权限管线与人机协同审批
                            perm_decision, perm_reason = permission_manager.evaluate(
                                tc_name, tc_args, workspace_root=workspace_root
                            )
                            if perm_decision == PermissionDecision.DENY:
                                is_error = True
                                res_payload = {"error": perm_reason}
                            elif perm_decision == PermissionDecision.ASK:
                                yield format_sse(
                                    "permission_request",
                                    {
                                        "session_id": str(session_id),
                                        "tool_call_id": tc_id,
                                        "name": tc_name,
                                        "args": tc_args,
                                        "reason": perm_reason,
                                        "step": step,
                                    },
                                )
                                approval_fut = permission_manager.register_approval(
                                    str(session_id), tc_id
                                )
                                try:
                                    user_approved = await asyncio.wait_for(
                                        approval_fut, timeout=60.0
                                    )
                                except asyncio.TimeoutError:
                                    user_approved = False
                                    logger.info("会话 [%s] 工具 [%s] 审批超时，自动判定拒绝", session_id, tc_id)

                                if not user_approved:
                                    is_error = True
                                    res_payload = {"error": f"操作已被用户（或超时）拒绝执行: {perm_reason}"}

                        if res_payload is None and not is_error:
                            if tool_meta.get("type") == "workspace":
                                kind, target, method = ToolAdapter.parse_namespaced_tool(tc_name)
                                # 优先判断是否走本地 Bridge 隧道
                                if workspace_root.startswith("bridge://"):
                                    from services.bridge_manager import BridgeManager
                                    bridge = BridgeManager.get_instance()
                                    uid = str(user_id)
                                    if method == "delete_file":
                                        res_payload = await bridge.call_rpc(uid, "fs.deleteFile", {"path": tc_args.get("path", "")})
                                    elif method == "write_file":
                                        res_payload = await bridge.call_rpc(uid, "fs.writeFile", {"path": tc_args.get("path", ""), "content": tc_args.get("content", "")})
                                    elif method == "edit_file":
                                        res_payload = await bridge.call_rpc(uid, "fs.editFile", {"path": tc_args.get("path", ""), "old_string": tc_args.get("old_string", ""), "new_string": tc_args.get("new_string", "")})
                                    elif method == "read_file":
                                        res_payload = await bridge.call_rpc(uid, "fs.readFile", {"path": tc_args.get("path", "")})
                                    elif method == "list_dir":
                                        res_payload = await bridge.call_rpc(uid, "fs.listDir", {"path": tc_args.get("path", "."), "recursive": tc_args.get("recursive", False)})
                                    elif method == "execute_command":
                                        res_payload = await bridge.call_rpc(uid, "shell.execute", {"command": tc_args.get("command", ""), "timeout": tc_args.get("timeout", 60)})
                                    elif method == "grep_search":
                                        res_payload = await bridge.call_rpc(uid, "fs.grepSearch", {"query": tc_args.get("query", ""), "path": tc_args.get("path", ".")})
                                    elif method == "find_by_name":
                                        res_payload = await bridge.call_rpc(uid, "fs.findByName", {"pattern": tc_args.get("pattern", "*"), "path": tc_args.get("path", ".")})
                                    elif method == "stop_process":
                                        res_payload = {"success": True, "message": "已向本地 Bridge 节点发送停止信号"}
                                    else:
                                        res_payload = {"success": False, "error": f"Bridge 模式暂不支持工具: {method}"}
                                elif method == "delete_file":
                                    res_payload = await asyncio.wait_for(
                                        asyncio.to_thread(
                                            WorkspaceToolExecutor.delete_file,
                                            workspace_root=workspace_root,
                                            path=tc_args.get("path", ""),
                                        ),
                                        timeout=15.0,
                                    )
                                elif method == "write_file":
                                    res_payload = await asyncio.wait_for(
                                        asyncio.to_thread(
                                            WorkspaceToolExecutor.write_file,
                                            workspace_root=workspace_root,
                                            path=tc_args.get("path", ""),
                                            content=tc_args.get("content", ""),
                                            overwrite=tc_args.get("overwrite", True),
                                        ),
                                        timeout=15.0,
                                    )
                                elif method == "edit_file":
                                    res_payload = await asyncio.wait_for(
                                        asyncio.to_thread(
                                            WorkspaceToolExecutor.edit_file,
                                            workspace_root=workspace_root,
                                            path=tc_args.get("path", ""),
                                            old_string=tc_args.get("old_string", ""),
                                            new_string=tc_args.get("new_string", ""),
                                        ),
                                        timeout=15.0,
                                    )
                                elif method == "read_file":
                                    res_payload = await asyncio.wait_for(
                                        asyncio.to_thread(
                                            WorkspaceToolExecutor.read_file,
                                            workspace_root=workspace_root,
                                            path=tc_args.get("path", ""),
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
                                elif method == "execute_command":
                                    res_payload = await WorkspaceToolExecutor.execute_command(
                                        workspace_root=workspace_root,
                                        command=tc_args.get("command", ""),
                                        timeout=tc_args.get("timeout", 30),
                                        is_background=tc_args.get("is_background"),
                                        session_id=str(session_id),
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
                                        timeout=20.0,
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
                                elif method == "stop_process":
                                    pid_val = int(tc_args.get("pid", 0))
                                    ok = WorkspaceToolExecutor.stop_background_process(pid_val)
                                    res_payload = {
                                        "success": ok,
                                        "pid": pid_val,
                                        "message": f"后台进程 (PID: {pid_val}) 已成功停止并清理完毕",
                                    }
                                elif method == "todo_write":
                                    from services.todo_manager import todo_manager
                                    if isinstance(tc_args, list):
                                        raw_todos = tc_args
                                    elif isinstance(tc_args, dict):
                                        raw_todos = (
                                            tc_args.get("todos")
                                            or tc_args.get("tasks")
                                            or tc_args.get("items")
                                            or tc_args.get("todo_list")
                                            or []
                                        )
                                    else:
                                        raw_todos = []
                                    if isinstance(raw_todos, str):
                                        try:
                                            raw_todos = json.loads(raw_todos)
                                        except Exception:
                                            raw_todos = []
                                    if not isinstance(raw_todos, list):
                                        raw_todos = []
                                    todo_manager.set_todos(str(session_id), raw_todos)
                                    # 读取校验与补齐 ID 后的标准 todos 结构
                                    validated_todos = todo_manager.get_todos(str(session_id))
                                    # 立即向前端 SSE 流推送 workbench_todos 事件以实时更新 UI 任务栏
                                    yield format_sse(
                                        SSEEventName.WORKBENCH_TODOS.value,
                                        {
                                            "session_id": str(session_id),
                                            "todos": validated_todos,
                                            "step": step,
                                        },
                                    )
                                    snap_str = todo_manager.format_todo_snapshot(str(session_id))
                                    res_payload = {
                                        "success": True,
                                        "todos": validated_todos,
                                        "count": len(validated_todos),
                                        "snapshot": snap_str,
                                        "message": f"待办任务状态机已更新（共 {len(validated_todos)} 项）",
                                    }
                                else:
                                    raise AppException(
                                        code=ErrorCode.NOT_FOUND,
                                        message=f"未找到工作区操作方法: {method}",
                                    )
                            elif tool_meta.get("type") == "skill":
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

                    if isinstance(res_payload, dict) and res_payload.get("success") is False:
                        is_error = True

                    # Claude Code (s08) 输出自动压缩与磁盘转储
                    if not is_error and res_payload:
                        res_payload = WorkspaceToolExecutor.compact_output(
                            workspace_root, res_payload
                        )

                    # 广播工具执行结果事件
                    yield format_sse(
                        SSEEventName.TOOL_CALL_RESULT.value,
                        {
                            "tool_call_id": tc_id,
                            "name": tc_name,
                            "result": res_payload,
                            "diff": res_payload.get("diff") if isinstance(res_payload, dict) else None,
                            "additions": res_payload.get("additions") if isinstance(res_payload, dict) else None,
                            "deletions": res_payload.get("deletions") if isinstance(res_payload, dict) else None,
                            "is_error": is_error,
                            "step": step,
                        },
                    )

                    # 广播工作台联动专属事件 (workbench_preview / workbench_file_change)
                    if not is_error and isinstance(res_payload, dict):
                        is_workspace_tool = (
                            tool_meta.get("type") == "workspace"
                            or tc_name.startswith("workspace__")
                        )
                        ws_method = None
                        if is_workspace_tool:
                            _, _, ws_method = ToolAdapter.parse_namespaced_tool(tc_name)

                        # 1. 文件变更事件：write_file 或 edit_file 成功落盘
                        if ws_method in ("write_file", "edit_file") and res_payload.get("success"):
                            yield format_sse(
                                SSEEventName.WORKBENCH_FILE_CHANGE.value,
                                {
                                    "path": res_payload.get("path") or tc_args.get("path", ""),
                                    "name": res_payload.get("name") or os.path.basename(res_payload.get("path", "")),
                                    "unified_diff": res_payload.get("diff", ""),
                                    "diff": res_payload.get("diff", ""),
                                    "additions": res_payload.get("additions", 0),
                                    "deletions": res_payload.get("deletions", 0),
                                    "original_content": res_payload.get("original_content", ""),
                                    "modified_content": res_payload.get("modified_content", ""),
                                },
                            )

                        # 2. 预览地址就绪事件：execute_command 探测到 Web 端口或服务地址
                        if ws_method == "execute_command":
                            detected_url = res_payload.get("url")
                            detected_port = None

                            if not detected_url:
                                combined_out = res_payload.get("stdout") or ""
                                if not combined_out and res_payload.get("recent_logs"):
                                    combined_out = "\n".join(res_payload.get("recent_logs") or [])
                                if combined_out:
                                    m = WorkspaceToolExecutor.PORT_REGEX.search(combined_out)
                                    if m:
                                        if m.groupdict().get("p4"):
                                            detected_url = m.group("p4")
                                        else:
                                            p_str = (
                                                m.groupdict().get("p1")
                                                or m.groupdict().get("p2")
                                                or m.groupdict().get("p3")
                                            )
                                            if p_str:
                                                detected_port = int(p_str)
                                                detected_url = f"http://localhost:{detected_port}"

                            if detected_url:
                                detected_url = detected_url.replace("://0.0.0.0", "://localhost")
                                if not detected_port:
                                    try:
                                        from urllib.parse import urlparse
                                        p = urlparse(detected_url)
                                        detected_port = p.port
                                    except Exception:
                                        pass

                                yield format_sse(
                                    SSEEventName.WORKBENCH_PREVIEW.value,
                                    {
                                        "url": detected_url,
                                        "port": detected_port,
                                    },
                                )

                    # 持久化 tool 角色消息入库 (经由 L1 守门员保护性截断)
                    tool_content_str = json.dumps(res_payload, ensure_ascii=False)
                    tool_content_str = self.context_manager.gate_tool_output(tool_content_str)
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
                    tool_mem_item: dict[str, Any] = {
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": tool_content_str,
                    }
                    if is_error:
                        tool_mem_item["is_error"] = True
                    messages.append(tool_mem_item)

                # ── 3b. 并发执行所有 dispatch_subagent 调用 ──
                if subagent_tool_calls:
                    from services.subagent_runner import subagent_runner

                    subagent_event_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
                    subagent_results: dict[str, dict[str, Any]] = {}

                    async def _run_single_subagent(
                        sa_tc: dict[str, Any],
                        agent_id: str,
                        q: asyncio.Queue,
                    ) -> None:
                        """在独立 task 中运行单个子代理，将进度事件推入共享队列，受全局 subagent_semaphore 保护"""
                        sa_args = sa_tc["arguments"]
                        sa_agent_type = str(sa_args.get("agent_type", "explore"))
                        sa_task_prompt = str(sa_args.get("task_prompt", ""))
                        sa_result: dict[str, Any] | None = None
                        try:
                            async with self.subagent_semaphore:
                                async for sub_chunk in subagent_runner.run(
                                    workspace_root=workspace_root,
                                    agent_type=sa_agent_type,
                                    task_prompt=sa_task_prompt,
                                    model=req.model,
                                    api_key=req.api_key,
                                    base_url=req.base_url,
                                    provider=req.provider,
                                    max_steps=8,
                                ):
                                    if sub_chunk["type"] == "progress":
                                        event_data = {**sub_chunk["data"], "agent_id": agent_id}
                                        await q.put({"type": "progress", "data": event_data})
                                    elif sub_chunk["type"] == "result":
                                        sa_result = sub_chunk["data"]
                        except asyncio.CancelledError:
                            logger.info("并发子代理 [%s] 任务被取消中断", agent_id)
                            sa_result = {"success": False, "error": "子代理任务已被取消"}
                            raise
                        except Exception as e:
                            logger.error("并发子代理 [%s] 执行异常: %s", agent_id, e)
                            sa_result = {"success": False, "error": str(e)}
                        finally:
                            if sa_result is None:
                                sa_result = {"success": False, "error": "子代理未产出有效结果"}

                            # 发送完成事件（若未被取消）
                            try:
                                await q.put({
                                    "type": "progress",
                                    "data": {
                                        "event": "subagent_progress",
                                        "agent_id": agent_id,
                                        "agent_type": sa_agent_type,
                                        "task_prompt": sa_task_prompt,
                                        "status": "completed" if sa_result.get("success") else "failed",
                                        "summary_preview": sa_result.get("summary", ""),
                                        "steps_taken": sa_result.get("steps_taken", 0),
                                    },
                                })
                            except Exception:
                                pass

                            # 核心保障：无论发生取消、异常还是正常完成，必须向队列推送 done 信号，防止主生成协程在 queue.get() 处永久死锁挂起
                            try:
                                await q.put({"type": "done", "agent_id": agent_id, "result": sa_result})
                            except Exception:
                                pass

                    # 为每个子代理创建并发 task
                    running_tasks: list[asyncio.Task] = []
                    agent_id_map: dict[str, dict[str, Any]] = {}  # agent_id -> tc
                    for sa_tc in subagent_tool_calls:
                        agent_id = f"agent-{sa_tc['id']}"
                        agent_id_map[agent_id] = sa_tc
                        task = asyncio.create_task(
                            _run_single_subagent(sa_tc, agent_id, subagent_event_queue)
                        )
                        running_tasks.append(task)

                    # 从队列中消费事件并 yield，直到所有子代理完成
                    try:
                        completed_count = 0
                        while completed_count < len(running_tasks):
                            event = await subagent_event_queue.get()
                            if event["type"] == "done":
                                completed_count += 1
                                agent_id = event["agent_id"]
                                sa_result = event["result"]
                                subagent_results[agent_id] = sa_result
                            elif event["type"] == "progress":
                                yield format_sse("subagent_progress", event["data"])
                    except (asyncio.CancelledError, GeneratorExit):
                        logger.info("主生成协程被取消，正在中止所有正在运行的并发子代理...")
                        for t in running_tasks:
                            if not t.done():
                                t.cancel()
                        raise
                    finally:
                        # 确保所有 task 彻底退出清理
                        for t in running_tasks:
                            if not t.done():
                                t.cancel()
                        await asyncio.gather(*running_tasks, return_exceptions=True)

                    # 为每个子代理写入 tool_result 到 messages 和数据库
                    for agent_id, sa_tc in agent_id_map.items():
                        sa_tc_id = sa_tc["id"]
                        sa_tc_name = sa_tc["name"]
                        sa_result = subagent_results.get(agent_id, {"success": False, "error": "未知错误"})
                        sa_is_error = not sa_result.get("success", False)

                        if not sa_is_error and sa_result:
                            sa_result = WorkspaceToolExecutor.compact_output(
                                workspace_root, sa_result, max_chars=32000
                            )

                        yield format_sse(
                            SSEEventName.TOOL_CALL_RESULT.value,
                            {
                                "tool_call_id": sa_tc_id,
                                "agent_id": agent_id,
                                "name": sa_tc_name,
                                "result": sa_result,
                                "is_error": sa_is_error,
                                "step": step,
                            },
                        )

                        sa_content_str = json.dumps(sa_result, ensure_ascii=False)
                        sa_content_str = self.context_manager.gate_tool_output(sa_content_str)
                        sa_tool_msg = await self.message_repo.create(
                            user_id=user_id,
                            msg_in=MessageCreate(
                                session_id=session_id,
                                parent_id=last_message_id,
                                role=MessageRole.TOOL,
                                content=sa_content_str,
                                tool_call_id=sa_tc_id,
                                status=MessageStatus.SUCCESS if not sa_is_error else MessageStatus.FAILED,
                            ),
                        )
                        last_message_id = sa_tool_msg["id"]

                        sa_mem_item: dict[str, Any] = {
                            "role": "tool",
                            "tool_call_id": sa_tc_id,
                            "content": sa_content_str,
                        }
                        if sa_is_error:
                            sa_mem_item["is_error"] = True
                        messages.append(sa_mem_item)

                yield format_sse(
                    SSEEventName.STEP_FINISH.value,
                    {"step": step, "finish_reason": "tool_calls"},
                )

                # 4. 检查运行中实时插话队列 (Mid-task Steering)
                steered_texts: list[str] = []
                while not steering_queue.empty():
                    try:
                        st = steering_queue.get_nowait()
                        if st and str(st).strip():
                            steered_texts.append(str(st).strip())
                    except asyncio.QueueEmpty:
                        break

                if steered_texts:
                    combined_steer = "\n\n".join(steered_texts)
                    logger.info("会话 [%s] 在 Step %d 检测到实时插话: %s", session_id, step, combined_steer)
                    # 持久化为新的 user 消息节点
                    steer_msg = await self.message_repo.create(
                        user_id=user_id,
                        msg_in=MessageCreate(
                            session_id=session_id,
                            parent_id=last_message_id,
                            role=MessageRole.USER,
                            content=combined_steer,
                            status=MessageStatus.SUCCESS,
                        ),
                    )
                    last_message_id = steer_msg["id"]
                    # 追加到上下文末尾，让大模型在下一步自然转向
                    messages.append({"role": "user", "content": combined_steer})
                    yield format_sse(
                        SSEEventName.MID_TASK_STEERED.value,
                        {
                            "session_id": str(session_id),
                            "content": combined_steer,
                            "step": step,
                        },
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

            # 若有未被执行的剩余插话指令，兜底持久化入库避免消息丢失
            leftover_steers = []
            while not steering_queue.empty():
                try:
                    st = steering_queue.get_nowait()
                    if st and str(st).strip():
                        leftover_steers.append(str(st).strip())
                except asyncio.QueueEmpty:
                    break
            if leftover_steers:
                combined_leftover = "\n\n".join(leftover_steers)
                await self.message_repo.create(
                    user_id=user_id,
                    msg_in=MessageCreate(
                        session_id=session_id,
                        parent_id=last_message_id,
                        role=MessageRole.USER,
                        content=combined_leftover,
                        status=MessageStatus.SUCCESS,
                    ),
                )

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

            # 4. 广播全流程完成事件并持久化本轮 metrics
            wall_clock_ms = int((time.time() - run_t0) * 1000)
            metrics_dict = {
                "latency_ms": wall_clock_ms,
                "tokens": (total_input_tokens + total_output_tokens) if (total_input_tokens + total_output_tokens) > 0 else None,
                "input_tokens": total_input_tokens if total_input_tokens > 0 else None,
                "output_tokens": total_output_tokens if total_output_tokens > 0 else None,
            }
            if last_message_id:
                try:
                    await self.message_repo.update_metrics(last_message_id, metrics_dict)
                except Exception as _e:
                    logger.warning("更新消息 metrics 失败: %s", _e)

            yield format_sse(
                SSEEventName.DONE.value,
                {
                    "session_id": str(session_id),
                    "last_message_id": str(last_message_id),
                    "total_steps": step if step <= max_steps else max_steps,
                    "duration_ms": wall_clock_ms,
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
            self._steering_queues.pop(task_key, None)
            self.unregister_task(user_id, session_id)
            permission_manager.cancel_session_approvals(str(session_id))
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
