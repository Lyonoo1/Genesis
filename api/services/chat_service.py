import asyncio
import json
import logging
import os
import re
import time
from typing import Any, AsyncGenerator, Optional
from uuid import UUID

from core.config import settings
from core.exceptions import AppException, ErrorCode
from core.workspace_guard import (
    get_api_source_root,
    get_isolated_sandbox_workspace,
    is_forbidden_workspace_path,
    is_restricted_env,
    is_sandbox_root_path,
)
from models.schemas.chat import SSEEventName, ChatRequest
from models.schemas.message import MessageCreate, MessageRole, MessageStatus, ToolCallItem
from models.schemas.session import SessionUpdate
from models.schemas.stream_envelope import (
    AgentLifecycleState,
    AgentRunMode,
    EnvelopeEmitter,
    StreamChannel,
)
from repositories.message_repository import MessageRepository
from repositories.session_repository import SessionRepository
from repositories.mcp_repository import McpRepository
from repositories.skill_repository import SkillRepository
from repositories.project_repository import ProjectRepository
from services.agent_state_machine import (
    AgentStateMachine,
    PreemptiveController,
    tool_registry,
)
from services.context_manager import ContextManager, context_manager
from services.llm_adapter import LLMAdapter, llm_adapter, StreamChunk
from services.mcp_client import McpClientManager, mcp_client_manager
from services.permission_manager import (
    PermissionDecision,
    PermissionMode,
    build_scope_signature,
    build_tool_approval_item,
    permission_manager,
)
from services.skill_engine import SkillEngine, skill_engine
from services.terminal_manager import get_default_workspace
from services.agent_guard import (
    DoomLoopDetector,
    resolve_effective_model_credentials,
)
from services.tool_adapter import ToolAdapter
from services.workspace_tool_executor import WorkspaceToolExecutor
import services.multi_agent_mesh  # noqa: F401 - 确保多代理工具注册到 tool_registry
import services.pty_tool_bridge  # noqa: F401 - 确保 PTY 工具注册到 tool_registry

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
    """Agent ReAct Loop 核心编排引擎：驱动多步 Tool Calling、状态机、抢占控制与流式信封推送"""

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
        self._preemptive_controllers: dict[str, PreemptiveController] = {}
        self._state_machines: dict[str, AgentStateMachine] = {}
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

    def get_preemptive_controller(
        self, user_id: str, session_id: Any
    ) -> Optional[PreemptiveController]:
        key = self._task_key(user_id, session_id)
        return self._preemptive_controllers.get(key)

    def get_state_machine(
        self, user_id: str, session_id: Any
    ) -> Optional[AgentStateMachine]:
        key = self._task_key(user_id, session_id)
        return self._state_machines.get(key)

    def add_steering_message(
        self,
        user_id: str,
        session_id: Any,
        text: str,
        preempt: bool = True,
    ) -> bool:
        """向正在运行中的会话投递实时插话指令 (Mid-task Steering)，默认支持微秒级抢占中断并自动结案挂起确认"""
        key = self._task_key(user_id, session_id)
        sid = str(session_id)
        controller = self._preemptive_controllers.get(key)
        if controller is not None and self.is_task_running(user_id, session_id):
            # Chat Override：先注入 steering 队列与抢占信号，再原子唤醒挂起确认 Future
            controller.trigger_steer(text, preempt=preempt)
            permission_manager.supersede_session(sid, text)
            permission_manager.advance_user_turn(sid)
            logger.info(
                "会话 [%s] 成功投递实时插话指令 (preempt=%s): %s",
                session_id,
                preempt,
                text[:60],
            )
            return True

        q = self._steering_queues.get(key)
        if q is not None and self.is_task_running(user_id, session_id):
            q.put_nowait(text)
            permission_manager.supersede_session(sid, text)
            permission_manager.advance_user_turn(sid)
            logger.info("会话 [%s] 成功加入实时插话指令: %s", session_id, text[:60])
            return True
        logger.warning("会话 [%s] 当前无正在运行的任务或插话队列不可用", session_id)
        return False

    def stop_task(self, user_id: str, session_id: Any) -> bool:
        """秒级 cancel 当前会话运行中的 Task 并中止关联子任务"""
        key = self._task_key(user_id, session_id)
        controller = self._preemptive_controllers.get(key)
        if controller is not None:
            controller.trigger_abort()
        try:
            from services.multi_agent_mesh import multi_agent_mesh

            multi_agent_mesh.stop_session_agents(str(session_id))
        except Exception as err:
            logger.debug("清理会话 [%s] 网格子代理失败: %s", session_id, err)
        task = RUNNING_TASKS.get(key)
        if task and not task.done():
            task.cancel()
            self.unregister_task(user_id, session_id)
            logger.info("已成功取消会话 [%s] 正在运行的生成任务", session_id)
            return True
        return False

    async def resolve_workspace_info(
        self,
        user_id: str,
        session_id: Any = None,
        explicit_path: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """多级解析当前会话对应的工作区路径与绑定状态元数据"""
        # 0. 优先检测当前用户是否已建立本地 Bridge 反向隧道
        from services.bridge_manager import BridgeManager

        bridge = BridgeManager.get_instance()
        if bridge.is_connected(str(user_id)):
            meta = bridge.get_metadata(str(user_id)) or {}
            cwd = meta.get("cwd") or "."
            return {
                "workspace_root": f"bridge://{user_id}::{cwd}",
                "bound": True,
                "workspace_mode": "bridge",
                "is_bridge": True,
                "is_sandbox": False,
            }

        # 1. 显式传入的合法目录路径
        if (
            explicit_path
            and os.path.isdir(explicit_path)
            and not is_forbidden_workspace_path(explicit_path)
        ):
            return {
                "workspace_root": os.path.abspath(explicit_path),
                "bound": True,
                "workspace_mode": "explicit",
                "is_bridge": False,
                "is_sandbox": False,
            }

        # 2. 尝试通过 session / project 反查项目名称与关联文件夹
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

        # 若项目已明确绑定了本地存在的合法绝对目录路径，最高优先级命中 (桌面端或本地真实绑定)
        for candidate_name in [project_folder, project_name]:
            if (
                candidate_name
                and os.path.isabs(candidate_name)
                and os.path.isdir(candidate_name)
                and not is_forbidden_workspace_path(candidate_name)
            ):
                return {
                    "workspace_root": os.path.abspath(candidate_name),
                    "bound": True,
                    "workspace_mode": "project",
                    "is_bridge": False,
                    "is_sandbox": False,
                }

        # 3. 环境变量 WORKSPACE_ROOT 次之 (需先通过源码/系统目录安全守卫校验)
        env_root = (os.environ.get("WORKSPACE_ROOT") or "").strip()
        if env_root and not is_forbidden_workspace_path(env_root):
            # 若配置为生产隔离沙箱基目录 (如 /tmp/genesis/sandboxes/workspaces)，按用户隔离子目录并标记为未绑定
            if is_sandbox_root_path(env_root):
                sandbox_ws = get_isolated_sandbox_workspace(user_id=user_id, base_dir=env_root)
                return {
                    "workspace_root": sandbox_ws,
                    "bound": False,
                    "workspace_mode": "unbound",
                    "is_bridge": False,
                    "is_sandbox": True,
                }
            if os.path.isdir(env_root):
                return {
                    "workspace_root": os.path.abspath(env_root),
                    "bound": True,
                    "workspace_mode": "env",
                    "is_bridge": False,
                    "is_sandbox": False,
                }

        # 4. 仅在非生产、非容器的本地开发模式下允许回退到工程目录 (make dev)
        if not is_restricted_env():
            api_root = get_api_source_root()
            genesis_root = os.path.abspath(os.path.join(str(api_root), ".."))
            parent_dir = os.path.abspath(os.path.join(genesis_root, ".."))

            is_safe_parent = (
                os.path.isdir(parent_dir)
                and not is_forbidden_workspace_path(parent_dir)
            )
            is_safe_genesis = (
                os.path.isdir(genesis_root)
                and not is_forbidden_workspace_path(genesis_root)
            )

            for candidate_name in [project_folder, project_name]:
                if not candidate_name:
                    continue
                if is_safe_parent:
                    if os.path.basename(parent_dir).lower() == candidate_name.lower():
                        return {
                            "workspace_root": parent_dir,
                            "bound": True,
                            "workspace_mode": "local_dev",
                            "is_bridge": False,
                            "is_sandbox": False,
                        }
                    cand = os.path.join(parent_dir, candidate_name)
                    if os.path.isdir(cand) and not is_forbidden_workspace_path(cand):
                        return {
                            "workspace_root": os.path.abspath(cand),
                            "bound": True,
                            "workspace_mode": "local_dev",
                            "is_bridge": False,
                            "is_sandbox": False,
                        }
                if is_safe_genesis:
                    if os.path.basename(genesis_root).lower() == candidate_name.lower():
                        return {
                            "workspace_root": genesis_root,
                            "bound": True,
                            "workspace_mode": "local_dev",
                            "is_bridge": False,
                            "is_sandbox": False,
                        }
                    cand = os.path.join(genesis_root, candidate_name)
                    if os.path.isdir(cand) and not is_forbidden_workspace_path(cand):
                        return {
                            "workspace_root": os.path.abspath(cand),
                            "bound": True,
                            "workspace_mode": "local_dev",
                            "is_bridge": False,
                            "is_sandbox": False,
                        }

            if is_safe_parent:
                return {
                    "workspace_root": parent_dir,
                    "bound": True,
                    "workspace_mode": "local_dev",
                    "is_bridge": False,
                    "is_sandbox": False,
                }
            if is_safe_genesis:
                return {
                    "workspace_root": genesis_root,
                    "bound": True,
                    "workspace_mode": "local_dev",
                    "is_bridge": False,
                    "is_sandbox": False,
                }

        # 5. 生产/容器/最终安全兜底：严禁返回 /app、后端源码目录或系统目录，统一隔离至用户沙箱目录
        sandbox_ws = get_isolated_sandbox_workspace(user_id=user_id)
        return {
            "workspace_root": sandbox_ws,
            "bound": False,
            "workspace_mode": "unbound",
            "is_bridge": False,
            "is_sandbox": True,
        }

    async def resolve_workspace_root(
        self,
        user_id: str,
        session_id: Any = None,
        explicit_path: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> str:
        """多级解析当前会话对应的真实物理工作区绝对路径"""
        info = await self.resolve_workspace_info(
            user_id=user_id,
            session_id=session_id,
            explicit_path=explicit_path,
            project_id=project_id,
        )
        return str(info["workspace_root"])

    async def collect_tools(
        self,
        user_id: str,
        allow_ask_user: bool = True,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """收集当前用户所有可用的 Standard Tools，并建立反向查询元数据索引"""
        tools_list: list[dict[str, Any]] = []
        tools_lookup: dict[str, Any] = {}

        # 0. 注入系统内置工作区文件与命令操作工具 (保持 ToolAdapter 静态前缀顺序一致)
        for bt in ToolAdapter.BUILTIN_WORKSPACE_TOOLS:
            tools_list.append(bt)
            fn_name = bt["function"]["name"]
            tools_lookup[fn_name] = {"type": "workspace", "data": bt}

        # 0.5 注入内置结构化澄清与参数表单工具（受设置面板开关控制）
        if allow_ask_user:
            ask_tool = ToolAdapter.AGENT_ASK_USER_TOOL
            ask_name = ask_tool["function"]["name"]
            tools_list.append(ask_tool)
            tools_lookup[ask_name] = {"type": "agent", "method": "ask_user", "data": ask_tool}

        # 补充注册表中动态注册的自定义工具
        for reg_tool in tool_registry.list_tools():
            if reg_tool.name not in tools_lookup:
                schema = reg_tool.to_openai_schema()
                tools_list.append(schema)
                tools_lookup[reg_tool.name] = {"type": "workspace", "data": schema}

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
                temperature=0.2,
                max_tokens=30,
                api_key=api_key,
                base_url=base_url,
                provider=provider,
            )
            async for chunk in stream:
                if chunk.type == "text" and chunk.text:
                    accumulated += chunk.text
                    if "\n" in accumulated or len(accumulated) >= 24:
                        break
            return accumulated

        try:
            # 1. 尝试寻找同厂商的极速轻量模型 (如 deepseek-reasoner -> deepseek-chat)
            title_model = model
            lower_m = model.lower()
            for k, fast_model in FAST_TITLE_MODEL_MAPPING.items():
                if k in lower_m:
                    title_model = fast_model
                    break

            if title_model != model:
                try:
                    title_text = await _invoke_title_llm(title_model)
                except Exception as inner_err:
                    logger.info(
                        "同厂平替模型 [%s] 调用失败 (%s)，回退至用户原生模型 [%s]",
                        title_model,
                        inner_err,
                        model,
                    )
                    title_text = await _invoke_title_llm(model)
            else:
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
                    title = title[len(prefix) :].strip()

            title = title.rstrip(".。:：")

            if title and len(title) > 0:
                return title[:16]
        except Exception as e:
            logger.warning("智能提取标题异常，采用文本截断降级: %s", e)

        return cleaned[:10]

    @staticmethod
    async def _iter_preemptible_stream(
        stream: AsyncGenerator[StreamChunk, None],
        controller: PreemptiveController,
    ) -> AsyncGenerator[StreamChunk, None]:
        """受抢占监控的流式迭代器：当流等待期间触发 preempt_event 时微秒级中断底层 chunk 等待"""
        stream_iter = stream.__aiter__()
        interrupted_in_stream = False
        while True:
            if controller.abort_event.is_set():
                raise asyncio.CancelledError("Stream aborted")

            next_task: asyncio.Task[StreamChunk] = asyncio.ensure_future(
                stream_iter.__anext__()
            )
            controller.active_subtasks.add(next_task)
            try:
                chunk = await next_task
            except StopAsyncIteration:
                break
            except asyncio.CancelledError:
                if controller.preempt_event.is_set() and not controller.abort_event.is_set():
                    interrupted_in_stream = True
                    break
                raise
            finally:
                controller.active_subtasks.discard(next_task)

            yield chunk
            if interrupted_in_stream:
                break

    async def handle_stream(
        self,
        session_id: Any,
        req: ChatRequest,
        user_id: str,
        max_steps: int = 80,
    ) -> AsyncGenerator[str, None]:
        """核心 ReAct 流式生成器：协调持久化、状态机、抢占式恢复、语义防死循环与多步工具执行"""
        current_task = asyncio.current_task()
        if current_task:
            self.register_task(user_id, session_id, current_task)

        task_key = self._task_key(user_id, session_id)
        steering_queue: asyncio.Queue[str] = asyncio.Queue()
        self._steering_queues[task_key] = steering_queue

        # 统一解析模型配置与凭据：优先请求传入，缺失时回查 model_configs 兜底，并修正真实上下文窗口
        resolved_model_cfg = resolve_effective_model_credentials(
            user_id=str(user_id),
            model=req.model,
            api_key=req.api_key,
            base_url=req.base_url,
            provider=req.provider,
            context_window=req.context_window,
        )
        effective_model: str = resolved_model_cfg["model"]
        effective_api_key: Optional[str] = resolved_model_cfg["api_key"]
        effective_base_url: Optional[str] = resolved_model_cfg["base_url"]
        effective_provider: Optional[str] = resolved_model_cfg["provider"]
        effective_context_window: int = resolved_model_cfg["context_window"]

        emitter = EnvelopeEmitter()
        bg_sse_queue: asyncio.Queue[str] = asyncio.Queue()
        bg_emitter = emitter.fork_queued(bg_sse_queue)

        def _drain_bg_sse() -> list[str]:
            frames: list[str] = []
            while not bg_sse_queue.empty():
                try:
                    frames.append(bg_sse_queue.get_nowait())
                except asyncio.QueueEmpty:
                    break
            return frames

        run_mode = (
            AgentRunMode.ACT
            if getattr(req, "approved_plan_id", None)
            else AgentRunMode(getattr(req, "mode", None) or "act")
        )
        controller = PreemptiveController(
            session_id=str(session_id),
            steering_queue=steering_queue,
        )
        state_machine = AgentStateMachine(
            session_id=str(session_id),
            mode=run_mode,
            initial_state=AgentLifecycleState.IDLE,
            registry=tool_registry,
            controller=controller,
            emitter=bg_emitter,
        )
        self._preemptive_controllers[task_key] = controller
        self._state_machines[task_key] = state_machine

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
        yield emitter.emit_sse(
            "session_info",
            {
                "session_id": str(session_id),
                "model": effective_model,
                "mode": run_mode.value,
                "context_window": effective_context_window,
            },
            channel=StreamChannel.CHAT,
        )

        # 1.1 异步标题提炼机制
        title_task: Optional[asyncio.Task] = None
        try:
            sess = await self.session_repo.get_by_id(user_id, session_id)
            if sess and (not sess.get("title") or sess.get("title") == "新对话"):
                async def _title_worker():
                    try:
                        await asyncio.sleep(0.01)
                        generated = await self.generate_session_title(
                            content=req.content,
                            model=effective_model,
                            api_key=effective_api_key,
                            base_url=effective_base_url,
                            provider=effective_provider,
                        )
                        if generated:
                            curr = await self.session_repo.get_by_id(user_id, session_id)
                            if curr and (not curr.get("title") or curr.get("title") == "新对话"):
                                await self.session_repo.update(
                                    user_id, session_id, SessionUpdate(title=generated)
                                )
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
        loop_detector = DoomLoopDetector()
        permission_mode = PermissionMode.normalize(getattr(req, "permission_mode", None))
        allow_ask_user = bool(getattr(req, "allow_ask_user", True))
        permission_manager.advance_user_turn(str(session_id))

        try:
            # 2. 状态跃迁：编译上下文与动态工具装配
            if run_mode == AgentRunMode.PLAN:
                tr = state_machine.transition_to(
                    AgentLifecycleState.PLANNING,
                    reason="enter_plan_mode",
                    step=0,
                )
                yield emitter.emit_sse(
                    SSEEventName.STATE_TRANSITION.value,
                    tr,
                    channel=StreamChannel.PLAN_STATE,
                )
            else:
                state_machine.transition_to(
                    AgentLifecycleState.COMPILING_CONTEXT,
                    reason="build_initial_context",
                    step=0,
                )

            workspace_root = await self.resolve_workspace_root(
                user_id=user_id,
                session_id=session_id,
                explicit_path=req.workspace_path,
            )
            try:
                available_tools, tools_lookup = await self.collect_tools(
                    user_id, allow_ask_user=allow_ask_user
                )
            except TypeError:
                available_tools, tools_lookup = await self.collect_tools(user_id)
                if not allow_ask_user:
                    available_tools = [
                        t
                        for t in available_tools
                        if (t.get("function") or {}).get("name") != "agent__ask_user"
                    ]
                    tools_lookup.pop("agent__ask_user", None)
            messages = await self.context_manager.build_context(
                user_id=user_id,
                session_id=session_id,
                new_prompt=req.content,
                parent_id=req.parent_id,
                model=effective_model,
                has_tools=bool(available_tools),
                context_window=effective_context_window,
                workspace_root=workspace_root,
                mode=run_mode,
                emitter=emitter,
                api_key=effective_api_key,
                base_url=effective_base_url,
                provider=effective_provider,
            )

            # Codex 范式：纯日常问候门控检测与 <working_memory> 注入
            # 严格禁止直接改写历史消息追加 Todo 或问候提示以维护 90%+ Prefix-Cache 命中率
            # 动态上下文统一通过 ContextCompiler 的 <working_memory> 块在消息列表末尾单点挂载
            messages, _, _ = self.context_manager.compiler.attach_working_memory_to_messages(
                messages=messages,
                session_id=session_id,
                new_prompt=req.content,
                mode=run_mode,
                workspace_root=workspace_root,
            )

            # 若上下文编译器产出了遥测指标，优先发射 compiler 已绑定的信封，避免重复占用严格递增 seq
            if self.context_manager.compiler.last_telemetry_sse:
                yield self.context_manager.compiler.last_telemetry_sse
                self.context_manager.compiler.last_telemetry_sse = None
            elif self.context_manager.compiler.last_telemetry:
                yield emitter.emit_sse(
                    SSEEventName.CONTEXT_TELEMETRY.value,
                    self.context_manager.compiler.last_telemetry.to_dict(),
                    channel=StreamChannel.CONTEXT_TELEMETRY,
                )

            step = 1

            # 3. 进入 ReAct 循环
            while step <= max_steps:
                logger.info(
                    "会话 [%s] 进入 ReAct Step %d (mode=%s, state=%s)",
                    session_id,
                    step,
                    state_machine.mode.value,
                    state_machine.state.value,
                )

                if state_machine.mode == AgentRunMode.PLAN:
                    if state_machine.state != AgentLifecycleState.PLANNING:
                        state_machine.transition_to(
                            AgentLifecycleState.PLANNING,
                            reason=f"step_{step}_planning",
                            step=step,
                        )
                else:
                    if state_machine.state != AgentLifecycleState.STREAMING_LLM:
                        state_machine.transition_to(
                            AgentLifecycleState.STREAMING_LLM,
                            reason=f"step_{step}_stream_llm",
                            step=step,
                        )

                step_text = ""
                step_reasoning = ""
                step_tool_calls: list[dict[str, Any]] = []

                # 保持 tools 静态前缀永不动态清除（即使在 PLAN 模式下也完整传入）
                effective_tools = available_tools if available_tools else None

                stream = self.llm_adapter.stream_chat(
                    messages=messages,
                    tools=effective_tools,
                    model=effective_model,
                    temperature=req.temperature or 0.7,
                    max_tokens=req.max_tokens,
                    api_key=effective_api_key,
                    base_url=effective_base_url,
                    provider=effective_provider,
                )

                finish_reason = "stop"
                received_finish = False
                async for chunk in self._iter_preemptible_stream(stream, controller):
                    if chunk.type == "text":
                        step_text += chunk.text or ""
                        controller.append_partial_text(chunk.text or "")
                        yield emitter.emit_sse(
                            SSEEventName.TEXT_DELTA.value,
                            {"delta": chunk.text, "step": step},
                        )
                    elif chunk.type == "reasoning":
                        step_reasoning += chunk.text or ""
                        yield emitter.emit_sse(
                            SSEEventName.REASONING_DELTA.value,
                            {"delta": chunk.text, "step": step},
                        )
                    elif chunk.type == "tool_start":
                        yield emitter.emit_sse(
                            SSEEventName.TOOL_CALL_START.value,
                            {
                                "tool_call_id": chunk.tool_call_id,
                                "name": chunk.tool_name,
                                "step": step,
                            },
                        )
                    elif chunk.type == "tool_delta":
                        yield emitter.emit_sse(
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
                        received_finish = True
                        finish_reason = chunk.finish_reason or "stop"
                        total_input_tokens += chunk.input_tokens
                        total_output_tokens += chunk.output_tokens

                    for bg_frame in _drain_bg_sse():
                        yield bg_frame

                for bg_frame in _drain_bg_sse():
                    yield bg_frame

                # 若在 LLM 流式输出阶段被微秒级抢占中断（未正常返回 finish chunk 且无工具调用）
                if (
                    controller.preempt_event.is_set()
                    and not controller.abort_event.is_set()
                    and not step_tool_calls
                    and not received_finish
                ):
                    state_machine.transition_to(
                        AgentLifecycleState.INTERRUPTED,
                        reason="preempted_during_llm_stream",
                        step=step,
                    )
                    anchor = controller.build_recovery_anchor(
                        step=step,
                        step_text=step_text,
                        partial_stdout=controller.partial_stdout,
                    )
                    steered_texts = controller.drain_steering_messages()
                    combined_steer = "\n\n".join(steered_texts)

                    yield emitter.emit_sse(
                        SSEEventName.PREEMPTED.value,
                        {
                            "session_id": str(session_id),
                            "step": step,
                            "partial_text": step_text,
                            "partial_stdout": controller.partial_stdout,
                            "steered_content": combined_steer,
                            "recovery_anchor": anchor,
                        },
                    )

                    if step_text or step_reasoning:
                        partial_asst = await self.message_repo.create(
                            user_id=user_id,
                            msg_in=MessageCreate(
                                session_id=session_id,
                                parent_id=last_message_id,
                                role=MessageRole.ASSISTANT,
                                content=step_text or step_reasoning,
                                reasoning_content=step_reasoning if step_reasoning else None,
                                status=MessageStatus.SUCCESS,
                            ),
                        )
                        last_message_id = partial_asst["id"]
                        messages.append(
                            {"role": "assistant", "content": step_text or step_reasoning}
                        )

                    if combined_steer:
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
                        messages.append(
                            {"role": "user", "content": f"{anchor}\n{combined_steer}"}
                        )
                        yield emitter.emit_sse(
                            SSEEventName.MID_TASK_STEERED.value,
                            {
                                "session_id": str(session_id),
                                "content": combined_steer,
                                "recovery_anchor": anchor,
                                "step": step,
                            },
                        )
                    else:
                        messages.append({"role": "user", "content": anchor})

                    controller.clear_preempt()
                    state_machine.transition_to(
                        AgentLifecycleState.COMPILING_CONTEXT,
                        reason="resume_after_llm_preempt",
                        step=step,
                    )
                    step += 1
                    continue

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
                            model=effective_model,
                            temperature=req.temperature or 0.7,
                            max_tokens=req.max_tokens,
                            api_key=effective_api_key,
                            base_url=effective_base_url,
                            provider=effective_provider,
                        )

                        finish_reason = "stop"
                        async for c in self._iter_preemptible_stream(continue_stream, controller):
                            if c.type == "text":
                                step_text += c.text or ""
                                yield emitter.emit_sse(
                                    SSEEventName.TEXT_DELTA.value,
                                    {"delta": c.text, "step": step},
                                )
                            elif c.type == "reasoning":
                                step_reasoning += c.text or ""
                                yield emitter.emit_sse(
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

                        if final_content:
                            yield emitter.emit_sse(
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

                    # 检测 <proposed_plan>...</proposed_plan> 标签并触发状态机跃迁与 PLAN_PROPOSED 事件
                    plan_info = state_machine.detect_proposed_plan(final_content, step=step)
                    if plan_info is not None:
                        yield emitter.emit_sse(
                            SSEEventName.STATE_TRANSITION.value,
                            state_machine.transition_history[-1],
                            channel=StreamChannel.PLAN_STATE,
                        )
                        yield emitter.emit_sse(
                            SSEEventName.PLAN_PROPOSED.value,
                            plan_info,
                            channel=StreamChannel.PLAN_STATE,
                        )

                    yield emitter.emit_sse(
                        SSEEventName.STEP_FINISH.value,
                        {"step": step, "finish_reason": finish_reason},
                    )

                    # 智能标题生成就绪广播
                    if title_task:
                        try:
                            if title_task.done():
                                gen_title = title_task.result()
                            else:
                                gen_title = await asyncio.wait_for(
                                    asyncio.shield(title_task), timeout=0.8
                                )
                            if gen_title:
                                yield emitter.emit_sse(
                                    SSEEventName.SESSION_TITLE_UPDATED.value,
                                    {"session_id": str(session_id), "title": gen_title},
                                )
                        except Exception:
                            pass
                        title_task = None

                    # 检查运行中实时插话队列 (Mid-task Steering)
                    steered_texts = controller.drain_steering_messages()
                    if steered_texts:
                        combined_steer = "\n\n".join(steered_texts)
                        logger.info(
                            "会话 [%s] 在 Step %d (文本回复结束) 检测到实时插话: %s",
                            session_id,
                            step,
                            combined_steer,
                        )
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
                        controller.clear_preempt()
                        state_machine.transition_to(
                            AgentLifecycleState.COMPILING_CONTEXT,
                            reason="steered_after_text_step",
                            step=step,
                        )
                        yield emitter.emit_sse(
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

                # 情况 B：模型触发了工具调用，通过 AgentStateMachine 执行多态工具派发
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

                # 分拣 subagent 调用与普通工具调用
                normal_tool_calls = []
                subagent_tool_calls = []
                step_tool_audit: list[dict[str, Any]] = []
                for tc in step_tool_calls:
                    _kind, _target, _method = ToolAdapter.parse_namespaced_tool(tc["name"])
                    if _kind == "workspace" and _method == "dispatch_subagent":
                        subagent_tool_calls.append(tc)
                    else:
                        normal_tool_calls.append(tc)

                # ── 3a-0. P2-4 预扫描合批：同一步 >= 2 个需审批且无同文件冲突的普通工具合并为 batch_approval ──
                pre_batch_decisions: dict[str, tuple[str, Optional[str]]] = {}
                is_plan_mode_active = (
                    state_machine.state == AgentLifecycleState.PLANNING
                    or state_machine.mode == AgentRunMode.PLAN
                )
                if len(normal_tool_calls) >= 2 and not controller.preempt_event.is_set():
                    pending_batch_items: list[dict[str, Any]] = []
                    batch_item_meta: list[tuple[str, str, Optional[str]]] = []  # (item_id, tc_id, perm_reason)
                    expected_item_scopes: dict[str, tuple[Optional[str], Optional[str]]] = {}

                    for tc in normal_tool_calls:
                        b_tc_id = tc["id"]
                        b_tc_name = tc["name"]
                        b_tc_args = tc["arguments"]
                        if b_tc_name == "agent__ask_user":
                            continue
                        if is_plan_mode_active and state_machine.is_tool_mutating(b_tc_name, b_tc_args):
                            continue
                        b_dec, b_reason = permission_manager.evaluate(
                            b_tc_name,
                            b_tc_args,
                            workspace_root=workspace_root,
                            permission_mode=permission_mode,
                        )
                        if b_dec != PermissionDecision.ASK:
                            continue
                        b_sig = build_scope_signature(
                            b_tc_name, b_tc_args, workspace_root=workspace_root
                        )
                        if permission_manager.is_allowed(
                            str(user_id), str(session_id), workspace_root, b_sig
                        ):
                            continue
                        b_item = build_tool_approval_item(
                            tool_call_id=b_tc_id,
                            tool_name=b_tc_name,
                            args=b_tc_args,
                            perm_reason=b_reason,
                            scope_signature=b_sig,
                            workspace_root=workspace_root,
                        )
                        pending_batch_items.append(b_item)
                        batch_item_meta.append((str(b_item["item_id"]), str(b_tc_id), b_reason))
                        expected_item_scopes[str(b_item["item_id"])] = (
                            b_sig,
                            b_item.get("risk_level"),
                        )

                    batch_paths = [
                        str(it["code_preview"].get("filename"))
                        for it in pending_batch_items
                        if isinstance(it.get("code_preview"), dict)
                        and it["code_preview"].get("filename")
                    ]
                    can_batch = len(pending_batch_items) >= 2 and len(batch_paths) == len(
                        set(batch_paths)
                    )
                    if can_batch:
                        from datetime import datetime, timedelta, timezone
                        from uuid import uuid4

                        batch_req_id = f"cfb_{step}_{uuid4().hex[:8]}"
                        timeout_s = settings.CONFIRMATION_TIMEOUT_S
                        expires_at = (
                            datetime.now(timezone.utc) + timedelta(seconds=timeout_s)
                        ).isoformat()
                        batch_envelope = {
                            "request_id": batch_req_id,
                            "session_id": str(session_id),
                            "agent_id": None,
                            "kind": "batch_approval",
                            "dismissible": True,
                            "allow_chat_override": True,
                            "timeout_ms": timeout_s * 1000,
                            "expires_at": expires_at,
                            "items": pending_batch_items,
                        }
                        batch_fut = permission_manager.register(
                            str(session_id),
                            batch_req_id,
                            envelope=batch_envelope,
                            user_id=str(user_id),
                            workspace_root=workspace_root,
                            expected_item_scopes=expected_item_scopes,
                        )
                        yield emitter.emit_sse(
                            SSEEventName.CONFIRMATION_REQUIRED.value,
                            batch_envelope,
                        )
                        try:
                            batch_result = await asyncio.wait_for(
                                batch_fut, timeout=timeout_s
                            )
                        except asyncio.TimeoutError:
                            permission_manager.resolve(
                                str(session_id),
                                batch_req_id,
                                {"decision": "timeout"},
                            )
                            batch_result = {"decision": "timeout"}
                            logger.info(
                                "会话 [%s] 批量审批 [%s] 超时 (%ss)，整批自动拒绝",
                                session_id,
                                batch_req_id,
                                timeout_s,
                            )
                        except asyncio.CancelledError:
                            permission_manager.resolve(
                                str(session_id),
                                batch_req_id,
                                {"decision": "dismissed"},
                            )
                            yield emitter.emit_sse(
                                SSEEventName.CONFIRMATION_RESOLVED.value,
                                {
                                    "request_id": batch_req_id,
                                    "decision": "dismissed",
                                },
                            )
                            raise

                        batch_decision = (
                            str(batch_result.get("decision") or "dismissed")
                            if isinstance(batch_result, dict)
                            else "dismissed"
                        )
                        yield emitter.emit_sse(
                            SSEEventName.CONFIRMATION_RESOLVED.value,
                            {
                                "request_id": batch_req_id,
                                "decision": batch_decision,
                            },
                        )

                        raw_item_decisions = (
                            batch_result.get("item_decisions")
                            if isinstance(batch_result, dict)
                            and isinstance(batch_result.get("item_decisions"), dict)
                            else {}
                        )
                        for b_item_id, b_tc_id, b_reason in batch_item_meta:
                            if batch_decision != "submitted":
                                pre_batch_decisions[b_tc_id] = (batch_decision, b_reason)
                            else:
                                entry_dec = raw_item_decisions.get(b_item_id)
                                dec_val = (
                                    str(entry_dec.get("decision") or "rejected")
                                    if isinstance(entry_dec, dict)
                                    else "rejected"
                                )
                                pre_batch_decisions[b_tc_id] = (
                                    "approved" if dec_val == "approved" else "rejected",
                                    b_reason,
                                )

                # ── 3a. 通过状态机串行执行普通工具 ──
                for tc in normal_tool_calls:
                    tc_id = tc["id"]
                    tc_name = tc["name"]
                    tc_args = tc["arguments"]

                    tool_meta = tools_lookup.get(tc_name)
                    res_payload: Any = None
                    is_error = False

                    # 若前序工具已被抢占中断，跳过后续工具直接填充恢复锚点
                    if controller.preempt_event.is_set() and not controller.abort_event.is_set():
                        anchor = controller.build_recovery_anchor(
                            step=step,
                            step_text=step_text,
                            partial_stdout=controller.partial_stdout,
                        )
                        res_payload = {
                            "success": False,
                            "preempted": True,
                            "recovery_anchor": anchor,
                            "error": anchor,
                        }
                        is_error = True
                    else:
                        try:
                            if not tool_meta:
                                kind, target, method = ToolAdapter.parse_namespaced_tool(tc_name)
                                if kind == "agent" and method == "ask_user":
                                    tool_meta = {"type": "agent", "method": "ask_user"}
                                elif kind == "workspace" or tool_registry.get(tc_name) is not None:
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

                            # Plan Mode 门控优先于权限弹窗：若处于 PLANNING 且为 mutating 工具，直接由状态机拦截
                            if (
                                state_machine.state == AgentLifecycleState.PLANNING
                                or state_machine.mode == AgentRunMode.PLAN
                            ) and state_machine.is_tool_mutating(tc_name, tc_args):
                                res_payload = await state_machine.execute_tool_call(
                                    tool_name=tc_name,
                                    tool_args=tc_args,
                                    workspace_root=workspace_root,
                                    user_id=str(user_id),
                                    session_id=str(session_id),
                                    tool_meta=tool_meta,
                                    skill_engine=self.skill_engine,
                                    mcp_client_manager=self.mcp_client_manager,
                                    controller=controller,
                                    step=step,
                                )
                                is_error = True

                            # 内置澄清/参数表单工具 agent__ask_user（Plan/Act 模式均允许，受双层防过度提问闸门约束）
                            if res_payload is None and not is_error and tc_name == "agent__ask_user":
                                if not allow_ask_user:
                                    res_payload = {
                                        "status": "disabled",
                                        "hint": "用户已在设置中关闭主动澄清提问，请基于现有上下文与合理假设直接执行。",
                                    }
                                else:
                                    ask_items, ask_kind = permission_manager.normalize_ask_items(
                                        tc_args.get("items")
                                    )
                                    if not ask_items:
                                        res_payload = {
                                            "status": "invalid_items",
                                            "hint": "提问参数 items 为空或无效，请直接基于现有上下文继续执行。",
                                        }
                                    else:
                                        quota_ok, short_circuit = permission_manager.check_and_consume_ask_quota(
                                            str(session_id)
                                        )
                                        if not quota_ok:
                                            res_payload = short_circuit
                                        else:
                                            request_id = f"cf_{tc_id}"
                                            timeout_s = settings.CONFIRMATION_TIMEOUT_S
                                            from datetime import datetime, timedelta, timezone
                                            expires_at = (
                                                datetime.now(timezone.utc) + timedelta(seconds=timeout_s)
                                            ).isoformat()
                                            ask_envelope = {
                                                "request_id": request_id,
                                                "session_id": str(session_id),
                                                "agent_id": None,
                                                "kind": ask_kind,
                                                "dismissible": True,
                                                "allow_chat_override": True,
                                                "timeout_ms": timeout_s * 1000,
                                                "expires_at": expires_at,
                                                "items": ask_items,
                                            }
                                            ask_fut = permission_manager.register(
                                                str(session_id),
                                                request_id,
                                                envelope=ask_envelope,
                                            )
                                            yield emitter.emit_sse(
                                                SSEEventName.CONFIRMATION_REQUIRED.value,
                                                ask_envelope,
                                            )
                                            try:
                                                ask_result = await asyncio.wait_for(
                                                    ask_fut, timeout=timeout_s
                                                )
                                            except asyncio.TimeoutError:
                                                permission_manager.resolve(
                                                    str(session_id),
                                                    request_id,
                                                    {"decision": "timeout"},
                                                )
                                                ask_result = {"decision": "timeout"}
                                                logger.info(
                                                    "会话 [%s] 澄清提问 [%s] 超时，按默认项推进",
                                                    session_id,
                                                    request_id,
                                                )
                                            except asyncio.CancelledError:
                                                permission_manager.resolve(
                                                    str(session_id),
                                                    request_id,
                                                    {"decision": "dismissed"},
                                                )
                                                yield emitter.emit_sse(
                                                    SSEEventName.CONFIRMATION_RESOLVED.value,
                                                    {
                                                        "request_id": request_id,
                                                        "decision": "dismissed",
                                                    },
                                                )
                                                raise

                                            decision = (
                                                str(ask_result.get("decision") or "dismissed")
                                                if isinstance(ask_result, dict)
                                                else "dismissed"
                                            )
                                            permission_manager.record_ask_outcome(
                                                str(session_id), decision
                                            )
                                            yield emitter.emit_sse(
                                                SSEEventName.CONFIRMATION_RESOLVED.value,
                                                {
                                                    "request_id": request_id,
                                                    "decision": decision,
                                                },
                                            )
                                            if decision == "submitted":
                                                res_payload = {
                                                    "status": "submitted",
                                                    "answers": (
                                                        ask_result.get("answers")
                                                        if isinstance(ask_result, dict)
                                                        else {}
                                                    )
                                                    or {},
                                                }
                                            elif decision == "superseded_by_message":
                                                res_payload = {
                                                    "status": "superseded_by_message",
                                                    "hint": "用户已发送新的消息指令，请优先遵循用户的最新消息推进。",
                                                }
                                            else:
                                                res_payload = {
                                                    "status": decision,
                                                    "hint": "用户未回答，请直接采用 recommended 默认项推进，禁止就同一问题再次提问",
                                                }

                            if res_payload is None and not is_error:
                                # 0. 三档权限管线 + 批量预决议 + 工作区/会话白名单 + 确认气泡协议
                                if tc_id in pre_batch_decisions:
                                    b_decision, b_perm_reason = pre_batch_decisions[tc_id]
                                    if b_decision != "approved":
                                        is_error = True
                                        res_payload = {
                                            "error": f"用户未批准（{b_decision}）: {b_perm_reason}"
                                        }
                                        ws_method = None
                                        if tc_name.startswith("workspace__"):
                                            _, _, ws_method = ToolAdapter.parse_namespaced_tool(tc_name)
                                        elif tc_name in ("edit_file", "write_file"):
                                            ws_method = tc_name
                                        if ws_method in ("edit_file", "write_file"):
                                            f_path = tc_args.get("path") or ""
                                            if f_path:
                                                from services.context_compiler import workspace_dirty_tracker
                                                workspace_dirty_tracker.record_user_external_modification(
                                                    session_id=str(session_id),
                                                    path=f_path,
                                                    source="diff_rejected",
                                                    patch_id=f"cfb_{tc_id}",
                                                )
                                else:
                                    perm_decision, perm_reason = permission_manager.evaluate(
                                        tc_name,
                                        tc_args,
                                        workspace_root=workspace_root,
                                        permission_mode=permission_mode,
                                    )
                                    sig = (
                                        build_scope_signature(
                                            tc_name, tc_args, workspace_root=workspace_root
                                        )
                                        if perm_decision == PermissionDecision.ASK
                                        else None
                                    )
                                    if (
                                        perm_decision == PermissionDecision.ASK
                                        and permission_manager.is_allowed(
                                            str(user_id), str(session_id), workspace_root, sig
                                        )
                                    ):
                                        perm_decision = PermissionDecision.ALLOW

                                    if perm_decision == PermissionDecision.DENY:
                                        is_error = True
                                        res_payload = {"error": perm_reason}
                                    elif perm_decision == PermissionDecision.ASK:
                                        request_id = f"cf_{tc_id}"
                                        timeout_s = settings.CONFIRMATION_TIMEOUT_S
                                        from datetime import datetime, timedelta, timezone
                                        expires_at = (
                                            datetime.now(timezone.utc) + timedelta(seconds=timeout_s)
                                        ).isoformat()
                                        approval_item = build_tool_approval_item(
                                            tool_call_id=tc_id,
                                            tool_name=tc_name,
                                            args=tc_args,
                                            perm_reason=perm_reason,
                                            scope_signature=sig,
                                            workspace_root=workspace_root,
                                        )
                                        approval_envelope = {
                                            "request_id": request_id,
                                            "session_id": str(session_id),
                                            "agent_id": None,
                                            "kind": "tool_approval",
                                            "dismissible": True,
                                            "allow_chat_override": True,
                                            "timeout_ms": timeout_s * 1000,
                                            "expires_at": expires_at,
                                            "items": [approval_item],
                                        }
                                        approval_fut = permission_manager.register(
                                            str(session_id),
                                            request_id,
                                            expected_scope_signature=sig,
                                            envelope=approval_envelope,
                                            user_id=str(user_id),
                                            workspace_root=workspace_root,
                                            risk_level=approval_item.get("risk_level"),
                                        )
                                        yield emitter.emit_sse(
                                            SSEEventName.CONFIRMATION_REQUIRED.value,
                                            approval_envelope,
                                        )
                                        try:
                                            approval_result = await asyncio.wait_for(
                                                approval_fut, timeout=timeout_s
                                            )
                                        except asyncio.TimeoutError:
                                            permission_manager.resolve(
                                                str(session_id),
                                                request_id,
                                                {"decision": "timeout"},
                                            )
                                            approval_result = {"decision": "timeout"}
                                            logger.info(
                                                "会话 [%s] 工具 [%s] 审批超时 (%ss)，自动判定拒绝",
                                                session_id,
                                                tc_id,
                                                timeout_s,
                                            )
                                        except asyncio.CancelledError:
                                            permission_manager.resolve(
                                                str(session_id),
                                                request_id,
                                                {"decision": "dismissed"},
                                            )
                                            yield emitter.emit_sse(
                                                SSEEventName.CONFIRMATION_RESOLVED.value,
                                                {
                                                    "request_id": request_id,
                                                    "decision": "dismissed",
                                                },
                                            )
                                            raise

                                        if isinstance(approval_result, dict):
                                            decision = str(
                                                approval_result.get("decision") or "rejected"
                                            )
                                        else:
                                            decision = (
                                                "approved" if bool(approval_result) else "rejected"
                                            )

                                        yield emitter.emit_sse(
                                            SSEEventName.CONFIRMATION_RESOLVED.value,
                                            {
                                                "request_id": request_id,
                                                "decision": decision,
                                            },
                                        )

                                        if decision != "approved":
                                            is_error = True
                                            res_payload = {
                                                "error": f"用户未批准（{decision}）: {perm_reason}"
                                            }
                                            ws_method = None
                                            if tc_name.startswith("workspace__"):
                                                _, _, ws_method = ToolAdapter.parse_namespaced_tool(tc_name)
                                            elif tc_name in ("edit_file", "write_file"):
                                                ws_method = tc_name
                                            if ws_method in ("edit_file", "write_file"):
                                                f_path = tc_args.get("path") or ""
                                                if f_path:
                                                    from services.context_compiler import workspace_dirty_tracker
                                                    workspace_dirty_tracker.record_user_external_modification(
                                                        session_id=str(session_id),
                                                        path=f_path,
                                                        source="diff_rejected",
                                                        patch_id=tc_id,
                                                        workspace_root=workspace_root,
                                                    )

                            if res_payload is None and not is_error:
                                tool_task = asyncio.create_task(
                                    state_machine.execute_tool_call(
                                        tool_name=tc_name,
                                        tool_args=tc_args,
                                        workspace_root=workspace_root,
                                        user_id=str(user_id),
                                        session_id=str(session_id),
                                        tool_meta=tool_meta,
                                        skill_engine=self.skill_engine,
                                        mcp_client_manager=self.mcp_client_manager,
                                        controller=controller,
                                        step=step,
                                        emitter=bg_emitter,
                                        tool_call_id=tc_id,
                                        turn_id=emitter.turn_id,
                                        model=effective_model,
                                        api_key=effective_api_key,
                                        base_url=effective_base_url,
                                        provider=effective_provider,
                                        parent_messages=messages,
                                    )
                                )
                                try:
                                    while not tool_task.done():
                                        q_task = asyncio.create_task(bg_sse_queue.get())
                                        done_set, _ = await asyncio.wait(
                                            {tool_task, q_task},
                                            return_when=asyncio.FIRST_COMPLETED,
                                        )
                                        if q_task in done_set:
                                            yield q_task.result()
                                            for bg_frame in _drain_bg_sse():
                                                yield bg_frame
                                        else:
                                            q_task.cancel()
                                            try:
                                                await q_task
                                            except asyncio.CancelledError:
                                                pass
                                    for bg_frame in _drain_bg_sse():
                                        yield bg_frame
                                    res_payload = await tool_task
                                finally:
                                    if not tool_task.done():
                                        tool_task.cancel()
                                        try:
                                            await tool_task
                                        except (asyncio.CancelledError, Exception):
                                            pass
                        except Exception as exc:
                            is_error = True
                            res_payload = {"error": str(exc)}
                            logger.error("执行工具 [%s] 失败: %s", tc_name, exc)

                    if isinstance(res_payload, dict) and res_payload.get("success") is False:
                        is_error = True

                    # 若为 todo_write 且成功，实时推送 workbench_todos 事件
                    if not is_error and isinstance(res_payload, dict):
                        _, _, ws_method_check = ToolAdapter.parse_namespaced_tool(tc_name)
                        if ws_method_check == "todo_write" and res_payload.get("success"):
                            yield emitter.emit_sse(
                                SSEEventName.WORKBENCH_TODOS.value,
                                {
                                    "session_id": str(session_id),
                                    "todos": res_payload.get("todos", []),
                                    "step": step,
                                },
                            )

                    # Claude Code (s08) 输出自动压缩与磁盘转储
                    if not is_error and res_payload:
                        res_payload = WorkspaceToolExecutor.compact_output(
                            workspace_root, res_payload
                        )

                    # 广播工具执行结果事件
                    yield emitter.emit_sse(
                        SSEEventName.TOOL_CALL_RESULT.value,
                        {
                            "tool_call_id": tc_id,
                            "name": tc_name,
                            "result": res_payload,
                            "diff": res_payload.get("diff")
                            if isinstance(res_payload, dict)
                            else None,
                            "additions": res_payload.get("additions")
                            if isinstance(res_payload, dict)
                            else None,
                            "deletions": res_payload.get("deletions")
                            if isinstance(res_payload, dict)
                            else None,
                            "is_error": is_error,
                            "step": step,
                        },
                    )

                    # 广播工作台联动专属事件 (workbench_preview / workbench_file_change)
                    if not is_error and isinstance(res_payload, dict):
                        is_workspace_tool = (
                            (tool_meta and tool_meta.get("type") == "workspace")
                            or tc_name.startswith("workspace__")
                        )
                        ws_method = None
                        if is_workspace_tool:
                            _, _, ws_method = ToolAdapter.parse_namespaced_tool(tc_name)

                        # 登记 read_file / write_file / edit_file 文件的 Hash 到 WorkspaceDirtyTracker
                        if ws_method in ("read_file", "write_file", "edit_file"):
                            from services.context_compiler import workspace_dirty_tracker

                            f_path = res_payload.get("path") or tc_args.get("path", "")
                            if f_path:
                                if ws_method == "read_file":
                                    f_content = res_payload.get("content") or ""
                                    act = "read"
                                elif ws_method == "write_file":
                                    f_content = (
                                        res_payload.get("modified_content")
                                        or tc_args.get("content", "")
                                    )
                                    act = "write"
                                else:  # edit_file
                                    f_content = (
                                        res_payload.get("modified_content")
                                        or tc_args.get("new_string", "")
                                    )
                                    act = "edit"

                                if (
                                    not f_content
                                    and workspace_root
                                    and not str(workspace_root).startswith("bridge://")
                                ):
                                    try:
                                        from pathlib import Path

                                        disk_fp = (Path(workspace_root) / f_path).resolve()
                                        if disk_fp.exists() and disk_fp.is_file():
                                            f_content = disk_fp.read_text(
                                                encoding="utf-8", errors="replace"
                                            )
                                    except Exception:
                                        pass

                                workspace_dirty_tracker.record_agent_file_access(
                                    session_id=str(session_id),
                                    path=f_path,
                                    content=f_content,
                                    action=act,
                                    workspace_root=workspace_root,
                                )

                        # 1. 文件变更事件：write_file 或 edit_file 成功落盘
                        if ws_method in ("write_file", "edit_file") and res_payload.get("success"):
                            yield emitter.emit_sse(
                                SSEEventName.WORKBENCH_FILE_CHANGE.value,
                                {
                                    "path": res_payload.get("path") or tc_args.get("path", ""),
                                    "name": res_payload.get("name")
                                    or os.path.basename(res_payload.get("path", "")),
                                    "unified_diff": res_payload.get("diff", ""),
                                    "diff": res_payload.get("diff", ""),
                                    "additions": res_payload.get("additions", 0),
                                    "deletions": res_payload.get("deletions", 0),
                                    "original_content": res_payload.get("original_content", ""),
                                    "modified_content": res_payload.get("modified_content", ""),
                                    "patch_id": res_payload.get("patch_id"),
                                    "snapshot_id": res_payload.get("patch_id"),
                                },
                                channel=StreamChannel.WORKBENCH_DIFF,
                            )

                        # 2. 预览地址就绪事件：execute_command / exec_command / write_stdin 探测到 Web 端口或服务地址
                        if ws_method in ("execute_command", "exec_command", "write_stdin"):
                            detected_url = res_payload.get("url") or res_payload.get("detected_url")
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

                                yield emitter.emit_sse(
                                    SSEEventName.WORKBENCH_PREVIEW.value,
                                    {
                                        "url": detected_url,
                                        "port": detected_port,
                                    },
                                )

                    # 持久化 tool 角色消息入库
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

                    tool_mem_item: dict[str, Any] = {
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": tool_content_str,
                    }
                    if is_error:
                        tool_mem_item["is_error"] = True
                    messages.append(tool_mem_item)
                    step_tool_audit.append(
                        {
                            "name": tc_name,
                            "args": tc_args,
                            "is_error": is_error,
                            "output": res_payload,
                        }
                    )

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
                        sa_args = sa_tc["arguments"]
                        sa_agent_type = str(sa_args.get("agent_type", "explore"))
                        sa_task_prompt = str(sa_args.get("task_prompt", ""))
                        sa_result: dict[str, Any] | None = None
                        try:
                            # Plan Mode 下若尝试运行非只读子代理，由状态机门控拦截
                            if (
                                state_machine.state == AgentLifecycleState.PLANNING
                                or state_machine.mode == AgentRunMode.PLAN
                            ) and state_machine.is_tool_mutating(sa_tc["name"], sa_args):
                                sa_result = {
                                    "success": False,
                                    "error": state_machine.PLAN_MODE_REJECT_MESSAGE,
                                }
                            else:
                                async with self.subagent_semaphore:
                                    async for sub_chunk in subagent_runner.run(
                                        workspace_root=workspace_root,
                                        agent_type=sa_agent_type,
                                        task_prompt=sa_task_prompt,
                                        model=effective_model,
                                        api_key=effective_api_key,
                                        base_url=effective_base_url,
                                        provider=effective_provider,
                                        max_steps=12,
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
                            from services.agent_guard import extract_clean_error

                            err_code, err_msg = extract_clean_error(e)
                            logger.error("并发子代理 [%s] 执行异常 (%s): %s", agent_id, err_code, err_msg)
                            sa_result = {
                                "success": False,
                                "error": err_msg,
                                "error_code": err_code,
                            }
                        finally:
                            if sa_result is None:
                                sa_result = {"success": False, "error": "子代理未产出有效结果"}

                            try:
                                await q.put(
                                    {
                                        "type": "progress",
                                        "data": {
                                            "event": "subagent_progress",
                                            "agent_id": agent_id,
                                            "agent_type": sa_agent_type,
                                            "task_prompt": sa_task_prompt,
                                            "status": "completed"
                                            if sa_result.get("success")
                                            else "failed",
                                            "summary_preview": sa_result.get("summary", ""),
                                            "error_message": sa_result.get("error"),
                                            "error_code": sa_result.get("error_code"),
                                            "steps_taken": sa_result.get("steps_taken", 0),
                                        },
                                    }
                                )
                            except Exception:
                                pass

                            try:
                                await q.put(
                                    {"type": "done", "agent_id": agent_id, "result": sa_result}
                                )
                            except Exception:
                                pass

                    running_tasks: list[asyncio.Task] = []
                    agent_id_map: dict[str, dict[str, Any]] = {}
                    for sa_tc in subagent_tool_calls:
                        agent_id = f"agent-{sa_tc['id']}"
                        agent_id_map[agent_id] = sa_tc
                        task = asyncio.create_task(
                            _run_single_subagent(sa_tc, agent_id, subagent_event_queue)
                        )
                        running_tasks.append(task)
                        controller.active_subtasks.add(task)

                    try:
                        completed_count = 0
                        while completed_count < len(running_tasks):
                            if controller.preempt_event.is_set() and not controller.abort_event.is_set():
                                for t in running_tasks:
                                    if not t.done():
                                        t.cancel()
                                break
                            event = await subagent_event_queue.get()
                            if event["type"] == "done":
                                completed_count += 1
                                agent_id = event["agent_id"]
                                sa_result = event["result"]
                                subagent_results[agent_id] = sa_result
                            elif event["type"] == "progress":
                                yield emitter.emit_sse(
                                    "subagent_progress",
                                    event["data"],
                                    agent_id=str(event["data"].get("agent_id") or "root"),
                                )
                    except (asyncio.CancelledError, GeneratorExit):
                        logger.info("主生成协程被取消，正在中止所有正在运行的并发子代理...")
                        for t in running_tasks:
                            if not t.done():
                                t.cancel()
                        raise
                    finally:
                        for t in running_tasks:
                            controller.active_subtasks.discard(t)
                            if not t.done():
                                t.cancel()
                        await asyncio.gather(*running_tasks, return_exceptions=True)

                    for agent_id, sa_tc in agent_id_map.items():
                        sa_tc_id = sa_tc["id"]
                        sa_tc_name = sa_tc["name"]
                        sa_result = subagent_results.get(
                            agent_id, {"success": False, "error": "未知错误"}
                        )
                        sa_is_error = not sa_result.get("success", False)

                        if not sa_is_error and sa_result:
                            sa_result = WorkspaceToolExecutor.compact_output(
                                workspace_root, sa_result, max_chars=32000
                            )

                        yield emitter.emit_sse(
                            SSEEventName.TOOL_CALL_RESULT.value,
                            {
                                "tool_call_id": sa_tc_id,
                                "agent_id": agent_id,
                                "name": sa_tc_name,
                                "result": sa_result,
                                "is_error": sa_is_error,
                                "step": step,
                            },
                            agent_id=agent_id,
                            parent_call_id=sa_tc_id,
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
                                status=MessageStatus.SUCCESS
                                if not sa_is_error
                                else MessageStatus.FAILED,
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
                        step_tool_audit.append(
                            {
                                "name": sa_tc_name,
                                "args": sa_tc.get("arguments"),
                                "is_error": sa_is_error,
                                "output": sa_result,
                            }
                        )

                if state_machine.can_transition_to(AgentLifecycleState.EVALUATING):
                    state_machine.transition_to(
                        AgentLifecycleState.EVALUATING,
                        reason=f"step_{step}_tools_finished",
                        step=step,
                    )

                yield emitter.emit_sse(
                    SSEEventName.STEP_FINISH.value,
                    {"step": step, "finish_reason": "tool_calls"},
                )

                # 4. 检查微秒级抢占恢复与运行中实时插话队列 (Preemptive / Mid-task Steering)
                was_preempted = (
                    controller.preempt_event.is_set() and not controller.abort_event.is_set()
                )
                recovery_anchor: Optional[str] = None
                if was_preempted:
                    if state_machine.state != AgentLifecycleState.INTERRUPTED:
                        state_machine.transition_to(
                            AgentLifecycleState.INTERRUPTED,
                            reason="preempted_during_tool_step",
                            step=step,
                        )
                    recovery_anchor = controller.build_recovery_anchor(
                        step=step,
                        step_text=step_text,
                        partial_stdout=controller.partial_stdout,
                    )

                steered_texts = controller.drain_steering_messages()
                if was_preempted:
                    combined_steer_for_evt = "\n\n".join(steered_texts)
                    yield emitter.emit_sse(
                        SSEEventName.PREEMPTED.value,
                        {
                            "session_id": str(session_id),
                            "step": step,
                            "partial_text": step_text,
                            "partial_stdout": controller.partial_stdout,
                            "steered_content": combined_steer_for_evt,
                            "recovery_anchor": recovery_anchor,
                        },
                    )

                if steered_texts:
                    combined_steer = "\n\n".join(steered_texts)
                    logger.info(
                        "会话 [%s] 在 Step %d 检测到实时插话 (preempted=%s): %s",
                        session_id,
                        step,
                        was_preempted,
                        combined_steer,
                    )
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
                    merged_user_content = (
                        f"{recovery_anchor}\n{combined_steer}"
                        if recovery_anchor
                        else combined_steer
                    )
                    messages.append({"role": "user", "content": merged_user_content})
                    yield emitter.emit_sse(
                        SSEEventName.MID_TASK_STEERED.value,
                        {
                            "session_id": str(session_id),
                            "content": combined_steer,
                            "recovery_anchor": recovery_anchor,
                            "step": step,
                        },
                    )
                elif recovery_anchor:
                    messages.append({"role": "user", "content": recovery_anchor})

                if was_preempted:
                    controller.clear_preempt()
                    state_machine.transition_to(
                        AgentLifecycleState.COMPILING_CONTEXT,
                        reason="resume_after_tool_preempt",
                        step=step,
                    )

                # 5. 语义级防死循环检测（DoomLoopDetector）与高安全预算护栏
                loop_check = loop_detector.record_step(step_tool_audit)
                should_wrap_up = False
                wrap_reason = ""
                wrap_detail = ""

                if loop_check.triggered and loop_check.severity == "soft_nudge" and step < max_steps:
                    logger.info(
                        "会话 [%s] Step %d 触发防循环软纠偏 (%s): %s",
                        session_id,
                        step,
                        loop_check.reason,
                        loop_check.detail,
                    )
                    messages.append(
                        {
                            "role": "user",
                            "content": loop_detector.build_soft_nudge_message(loop_check),
                        }
                    )
                    yield emitter.emit_sse(
                        SSEEventName.SYSTEM_NOTICE.value,
                        {
                            "session_id": str(session_id),
                            "level": "info",
                            "reason": loop_check.reason,
                            "message": "检测到重复操作，已引导助手切换思路继续执行",
                            "detail": loop_check.detail,
                            "steps_taken": step,
                            "can_continue": False,
                        },
                    )
                elif loop_check.triggered and loop_check.severity == "hard_stop":
                    should_wrap_up = True
                    wrap_reason = "doom_loop_stopped"
                    wrap_detail = loop_check.detail
                elif step >= max_steps:
                    should_wrap_up = True
                    wrap_reason = "step_budget_reached"
                    wrap_detail = f"当前任务已连续执行 {step} 步，为保护额度已自动阶段性收尾"

                if should_wrap_up:
                    logger.warning(
                        "会话 [%s] Step %d 触发智能护栏收尾 (%s): %s",
                        session_id,
                        step,
                        wrap_reason,
                        wrap_detail,
                    )
                    # 发起一次无工具的优雅收尾总结，严禁把回答截断在半句话
                    wrap_messages = list(messages)
                    wrap_messages.append(
                        {
                            "role": "user",
                            "content": (
                                f"[系统收尾指令] 原因：{wrap_detail}。"
                                "请立即停止调用工具，直接基于目前已收集到的全部信息，给用户输出清晰、完整的阶段性结论与下一步建议。"
                            ),
                        }
                    )
                    wrap_text = ""
                    try:
                        wrap_stream = self.llm_adapter.stream_chat(
                            messages=wrap_messages,
                            tools=None,
                            model=effective_model,
                            temperature=0.3,
                            max_tokens=req.max_tokens or 4096,
                            api_key=effective_api_key,
                            base_url=effective_base_url,
                            provider=effective_provider,
                        )
                        async for wc in self._iter_preemptible_stream(wrap_stream, controller):
                            if wc.type == "text" and wc.text:
                                wrap_text += wc.text
                                yield emitter.emit_sse(
                                    SSEEventName.TEXT_DELTA.value,
                                    {"delta": wc.text, "step": step},
                                )
                            elif wc.type == "finish":
                                total_input_tokens += wc.input_tokens
                                total_output_tokens += wc.output_tokens
                    except Exception as wrap_err:
                        logger.warning("会话 [%s] 智能护栏收尾总结失败: %s", session_id, wrap_err)

                    if wrap_text.strip():
                        wrap_msg = await self.message_repo.create(
                            user_id=user_id,
                            msg_in=MessageCreate(
                                session_id=session_id,
                                parent_id=last_message_id,
                                role=MessageRole.ASSISTANT,
                                content=wrap_text.strip(),
                                status=MessageStatus.SUCCESS,
                            ),
                        )
                        last_message_id = wrap_msg["id"]

                    yield emitter.emit_sse(
                        SSEEventName.SYSTEM_NOTICE.value,
                        {
                            "session_id": str(session_id),
                            "level": "warning",
                            "reason": wrap_reason,
                            "message": (
                                "检测到重复尝试，已为您汇总当前发现并暂停执行"
                                if wrap_reason == "doom_loop_stopped"
                                else f"已完成阶段性 {step} 步探索并汇总当前进展"
                            ),
                            "detail": wrap_detail,
                            "steps_taken": step,
                            "max_steps": max_steps,
                            "can_continue": True,
                        },
                    )
                    break

                step += 1

            # 若有未被执行的剩余插话指令，兜底持久化入库避免消息丢失
            leftover_steers = controller.drain_steering_messages()
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
                        gen_title = await asyncio.wait_for(
                            asyncio.shield(title_task), timeout=0.8
                        )
                    if gen_title:
                        yield emitter.emit_sse(
                            SSEEventName.SESSION_TITLE_UPDATED.value,
                            {"session_id": str(session_id), "title": gen_title},
                        )
                except Exception:
                    pass
                title_task = None

            # 4. 广播全流程完成事件并持久化本轮 metrics
            if state_machine.state != AgentLifecycleState.AWAITING_PLAN_APPROVAL:
                if state_machine.can_transition_to(AgentLifecycleState.COMPLETED):
                    state_machine.transition_to(
                        AgentLifecycleState.COMPLETED,
                        reason="turn_completed",
                        step=step if step <= max_steps else max_steps,
                    )

            wall_clock_ms = int((time.time() - run_t0) * 1000)
            metrics_dict = {
                "latency_ms": wall_clock_ms,
                "tokens": (total_input_tokens + total_output_tokens)
                if (total_input_tokens + total_output_tokens) > 0
                else None,
                "input_tokens": total_input_tokens if total_input_tokens > 0 else None,
                "output_tokens": total_output_tokens if total_output_tokens > 0 else None,
            }
            if last_message_id:
                try:
                    await self.message_repo.update_metrics(last_message_id, metrics_dict)
                except Exception as _e:
                    logger.warning("更新消息 metrics 失败: %s", _e)

            for bg_frame in _drain_bg_sse():
                yield bg_frame

            yield emitter.emit_sse(
                SSEEventName.DONE.value,
                {
                    "session_id": str(session_id),
                    "last_message_id": str(last_message_id),
                    "total_steps": step if step <= max_steps else max_steps,
                    "duration_ms": wall_clock_ms,
                    "state": state_machine.state.value,
                    "mode": state_machine.mode.value,
                    "tokens": {
                        "input": total_input_tokens,
                        "output": total_output_tokens,
                    },
                },
            )

        except asyncio.CancelledError:
            logger.info("会话 [%s] 生成任务被客户端主动中止", session_id)
            yield emitter.emit_sse(
                SSEEventName.ERROR.value,
                {"code": "TASK_CANCELLED", "message": "生成任务已被中止"},
            )
        except AppException as exc:
            logger.error("会话 [%s] 业务异常: %s", session_id, exc.message)
            yield emitter.emit_sse(
                SSEEventName.ERROR.value,
                {"code": exc.code.value, "message": exc.message},
            )
        except Exception as exc:
            logger.exception("会话 [%s] 发生未知异常: %s", session_id, exc)
            yield emitter.emit_sse(
                SSEEventName.ERROR.value,
                {"code": "INTERNAL_ERROR", "message": str(exc)},
            )
        finally:
            self._steering_queues.pop(task_key, None)
            self._preemptive_controllers.pop(task_key, None)
            self._state_machines.pop(task_key, None)
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
