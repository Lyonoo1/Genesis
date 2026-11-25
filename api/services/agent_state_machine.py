import asyncio
import inspect
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from core.exceptions import AppException, ErrorCode
from models.schemas.chat import SSEEventName
from models.schemas.stream_envelope import (
    AgentLifecycleState,
    AgentRunMode,
    EnvelopeEmitter,
    StreamChannel,
)
from services.tool_adapter import ToolAdapter
from services.workspace_tool_executor import WorkspaceToolExecutor

logger = logging.getLogger("genesis.state_machine")


class InvalidStateTransitionError(RuntimeError):
    """非法状态机跃迁异常"""

    def __init__(
        self,
        from_state: AgentLifecycleState,
        to_state: AgentLifecycleState,
        reason: str = "",
    ):
        self.from_state = from_state
        self.to_state = to_state
        self.reason = reason
        msg = f"非法状态跃迁: {from_state.value} -> {to_state.value}"
        if reason:
            msg += f" ({reason})"
        super().__init__(msg)


class ToolPreemptedError(Exception):
    """工具或流在执行期间被用户实时插话微秒级抢占中断"""

    def __init__(self, message: str = "Execution preempted by user steering"):
        super().__init__(message)


@dataclass
class RegisteredTool:
    """声明式工具注册元数据模型"""

    name: str
    description: str
    parameters_schema: dict[str, Any]
    handler: Callable[..., Any]
    mutating: bool = False
    requires_approval: bool = False
    timeout_sec: float = 30.0
    supports_bridge: bool = True
    rollback_handler: Optional[Callable[..., Any]] = None

    def to_openai_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters_schema,
            },
        }


class ToolRegistry:
    """声明式工具注册表：统一管理工作区内置工具、读写属性、超时与回滚回调"""

    def __init__(self) -> None:
        self._tools: dict[str, RegisteredTool] = {}

    def register(
        self,
        name: str,
        description: str = "",
        parameters_schema: Optional[dict[str, Any]] = None,
        mutating: bool = False,
        requires_approval: bool = False,
        timeout_sec: float = 30.0,
        supports_bridge: bool = True,
        rollback_handler: Optional[Callable[..., Any]] = None,
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """装饰器：将函数注册为受状态机管控的标准工具"""
        schema = parameters_schema
        desc = description
        if schema is None or not desc:
            for bt in ToolAdapter.BUILTIN_WORKSPACE_TOOLS:
                fn_info = bt.get("function", {})
                if fn_info.get("name") == name:
                    if not desc:
                        desc = fn_info.get("description", "")
                    if schema is None:
                        schema = fn_info.get("parameters", {"type": "object", "properties": {}})
                    break
        if schema is None:
            schema = {"type": "object", "properties": {}}

        def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
            reg = RegisteredTool(
                name=name,
                description=desc,
                parameters_schema=schema,
                handler=func,
                mutating=mutating,
                requires_approval=requires_approval,
                timeout_sec=timeout_sec,
                supports_bridge=supports_bridge,
                rollback_handler=rollback_handler,
            )
            self._tools[name] = reg
            return func

        return decorator

    def register_tool(self, tool: RegisteredTool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Optional[RegisteredTool]:
        if name in self._tools:
            return self._tools[name]
        prefixed = f"{ToolAdapter.WORKSPACE_PREFIX}{name}"
        if prefixed in self._tools:
            return self._tools[prefixed]
        if name.startswith(ToolAdapter.WORKSPACE_PREFIX):
            unprefixed = name[len(ToolAdapter.WORKSPACE_PREFIX) :]
            if unprefixed in self._tools:
                return self._tools[unprefixed]
        return None

    def list_tools(self) -> list[RegisteredTool]:
        return list(self._tools.values())

    def to_openai_schemas(self) -> list[dict[str, Any]]:
        return [t.to_openai_schema() for t in self._tools.values()]


# 全局工具注册表单例
tool_registry = ToolRegistry()


def _rollback_workspace_file(
    workspace_root: str,
    path: str,
    original_content: Optional[str] = None,
    was_created: bool = False,
) -> dict[str, Any]:
    """文件变更回滚处理器"""
    try:
        full_path = WorkspaceToolExecutor.resolve_safe_path(workspace_root, path)
        if was_created or original_content is None:
            if full_path.exists():
                full_path.unlink()
            return {"success": True, "path": path, "action": "deleted_created_file"}
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(original_content, encoding="utf-8")
        return {"success": True, "path": path, "action": "restored_original"}
    except Exception as exc:
        return {"success": False, "path": path, "error": str(exc)}


# ============================================================================
# 注册全部内置工作区工具 (只读 mutating=False / 变更 mutating=True)
# ============================================================================


@tool_registry.register(
    name="workspace__read_file",
    mutating=False,
    requires_approval=False,
    timeout_sec=15.0,
    supports_bridge=True,
)
async def _handle_read_file(
    workspace_root: str,
    tc_args: dict[str, Any],
    **kwargs: Any,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        WorkspaceToolExecutor.read_file,
        workspace_root=workspace_root,
        path=tc_args.get("path", ""),
        offset=tc_args.get("offset", 1),
        limit=tc_args.get("limit", 200),
        with_line_numbers=tc_args.get("with_line_numbers", False),
    )


@tool_registry.register(
    name="workspace__list_dir",
    mutating=False,
    requires_approval=False,
    timeout_sec=15.0,
    supports_bridge=True,
)
async def _handle_list_dir(
    workspace_root: str,
    tc_args: dict[str, Any],
    **kwargs: Any,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        WorkspaceToolExecutor.list_dir,
        workspace_root=workspace_root,
        path=tc_args.get("path", "."),
        recursive=tc_args.get("recursive", False),
    )


@tool_registry.register(
    name="workspace__grep_search",
    mutating=False,
    requires_approval=False,
    timeout_sec=20.0,
    supports_bridge=True,
)
async def _handle_grep_search(
    workspace_root: str,
    tc_args: dict[str, Any],
    **kwargs: Any,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        WorkspaceToolExecutor.grep_search,
        workspace_root=workspace_root,
        query=tc_args.get("query", ""),
        path=tc_args.get("path", "."),
        case_sensitive=tc_args.get("case_sensitive", False),
        is_regex=tc_args.get("is_regex", False),
    )


@tool_registry.register(
    name="workspace__find_by_name",
    mutating=False,
    requires_approval=False,
    timeout_sec=15.0,
    supports_bridge=True,
)
async def _handle_find_by_name(
    workspace_root: str,
    tc_args: dict[str, Any],
    **kwargs: Any,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        WorkspaceToolExecutor.find_by_name,
        workspace_root=workspace_root,
        pattern=tc_args.get("pattern", "*"),
        path=tc_args.get("path", "."),
        type=tc_args.get("type", "any"),
    )


@tool_registry.register(
    name="workspace__dispatch_subagent",
    mutating=False,
    requires_approval=False,
    timeout_sec=120.0,
    supports_bridge=False,
)
async def _handle_dispatch_subagent(
    workspace_root: str,
    tc_args: dict[str, Any],
    user_id: Optional[str] = None,
    **kwargs: Any,
) -> dict[str, Any]:
    from services.subagent_runner import subagent_runner
    from services.agent_guard import resolve_effective_model_credentials

    agent_type = str(tc_args.get("agent_type", "explore"))
    task_prompt = str(tc_args.get("task_prompt", ""))
    resolved = resolve_effective_model_credentials(
        user_id=user_id,
        model=str(kwargs.get("model") or "gpt-4o"),
        api_key=kwargs.get("api_key"),
        base_url=kwargs.get("base_url"),
        provider=kwargs.get("provider"),
    )
    final_result: Optional[dict[str, Any]] = None
    async for chunk in subagent_runner.run(
        workspace_root=workspace_root,
        agent_type=agent_type,
        task_prompt=task_prompt,
        model=resolved["model"],
        api_key=resolved["api_key"],
        base_url=resolved["base_url"],
        provider=resolved["provider"],
        max_steps=12,
    ):
        if chunk.get("type") == "result":
            final_result = chunk.get("data")
    return final_result or {"success": False, "error": "子代理未返回有效结果"}


@tool_registry.register(
    name="workspace__write_file",
    mutating=True,
    requires_approval=False,
    timeout_sec=15.0,
    supports_bridge=True,
    rollback_handler=_rollback_workspace_file,
)
async def _handle_write_file(
    workspace_root: str,
    tc_args: dict[str, Any],
    session_id: Optional[str] = None,
    **kwargs: Any,
) -> dict[str, Any]:
    sid = str(session_id or kwargs.get("session_id") or "")
    return await asyncio.to_thread(
        WorkspaceToolExecutor.write_file,
        workspace_root=workspace_root,
        path=tc_args.get("path", ""),
        content=tc_args.get("content", ""),
        overwrite=tc_args.get("overwrite", True),
        session_id=sid or None,
        turn_id=kwargs.get("turn_id"),
        tool_call_id=kwargs.get("tool_call_id"),
    )


@tool_registry.register(
    name="workspace__edit_file",
    mutating=True,
    requires_approval=False,
    timeout_sec=15.0,
    supports_bridge=True,
    rollback_handler=_rollback_workspace_file,
)
async def _handle_edit_file(
    workspace_root: str,
    tc_args: dict[str, Any],
    session_id: Optional[str] = None,
    **kwargs: Any,
) -> dict[str, Any]:
    sid = str(session_id or kwargs.get("session_id") or "")
    return await asyncio.to_thread(
        WorkspaceToolExecutor.edit_file,
        workspace_root=workspace_root,
        path=tc_args.get("path", ""),
        old_string=tc_args.get("old_string", ""),
        new_string=tc_args.get("new_string", ""),
        session_id=sid or None,
        turn_id=kwargs.get("turn_id"),
        tool_call_id=kwargs.get("tool_call_id"),
    )


@tool_registry.register(
    name="workspace__delete_file",
    mutating=True,
    requires_approval=True,
    timeout_sec=15.0,
    supports_bridge=True,
    rollback_handler=_rollback_workspace_file,
)
async def _handle_delete_file(
    workspace_root: str,
    tc_args: dict[str, Any],
    **kwargs: Any,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        WorkspaceToolExecutor.delete_file,
        workspace_root=workspace_root,
        path=tc_args.get("path", ""),
    )


@tool_registry.register(
    name="workspace__execute_command",
    mutating=True,
    requires_approval=False,
    timeout_sec=30.0,
    supports_bridge=True,
)
async def _handle_execute_command(
    workspace_root: str,
    tc_args: dict[str, Any],
    session_id: Optional[str] = None,
    controller: Optional["PreemptiveController"] = None,
    **kwargs: Any,
) -> dict[str, Any]:
    on_stdout = controller.append_partial_stdout if controller is not None else None
    cmd_res = WorkspaceToolExecutor.execute_command(
        workspace_root=workspace_root,
        command=tc_args.get("command", ""),
        timeout=tc_args.get("timeout", 30),
        is_background=tc_args.get("is_background"),
        session_id=str(session_id) if session_id else None,
        on_stdout=on_stdout,
    )
    if inspect.isawaitable(cmd_res):
        return await cmd_res
    return cmd_res


@tool_registry.register(
    name="workspace__stop_process",
    mutating=True,
    requires_approval=False,
    timeout_sec=10.0,
    supports_bridge=True,
)
async def _handle_stop_process(
    workspace_root: str,
    tc_args: dict[str, Any],
    **kwargs: Any,
) -> dict[str, Any]:
    pid_val = int(tc_args.get("pid", 0))
    ok = WorkspaceToolExecutor.stop_background_process(pid_val)
    return {
        "success": ok,
        "pid": pid_val,
        "message": f"后台进程 (PID: {pid_val}) 已成功停止并清理完毕",
    }


@tool_registry.register(
    name="workspace__todo_write",
    mutating=True,
    requires_approval=False,
    timeout_sec=10.0,
    supports_bridge=False,
)
async def _handle_todo_write(
    workspace_root: str,
    tc_args: Any,
    session_id: Optional[str] = None,
    **kwargs: Any,
) -> dict[str, Any]:
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

    sid = str(session_id or "default")
    todo_manager.set_todos(sid, raw_todos)
    validated_todos = todo_manager.get_todos(sid)
    snap_str = todo_manager.format_todo_snapshot(sid)
    return {
        "success": True,
        "todos": validated_todos,
        "count": len(validated_todos),
        "snapshot": snap_str,
        "message": f"待办任务状态机已更新（共 {len(validated_todos)} 项）",
    }


async def _execute_bridge_rpc(
    method: str,
    tc_args: dict[str, Any],
    workspace_root: str,
    user_id: str,
) -> dict[str, Any]:
    """保留 bridge:// 隧道 RPC 分发逻辑"""
    from services.bridge_manager import BridgeManager

    bridge = BridgeManager.get_instance()
    uid = str(user_id) if user_id else workspace_root[len("bridge://") :].split("::", 1)[0]
    if method == "delete_file":
        return await bridge.call_rpc(uid, "fs.deleteFile", {"path": tc_args.get("path", "")})
    elif method == "write_file":
        return await bridge.call_rpc(
            uid,
            "fs.writeFile",
            {"path": tc_args.get("path", ""), "content": tc_args.get("content", "")},
        )
    elif method == "edit_file":
        return await bridge.call_rpc(
            uid,
            "fs.editFile",
            {
                "path": tc_args.get("path", ""),
                "old_string": tc_args.get("old_string", ""),
                "new_string": tc_args.get("new_string", ""),
            },
        )
    elif method == "read_file":
        return await bridge.call_rpc(uid, "fs.readFile", {"path": tc_args.get("path", "")})
    elif method == "list_dir":
        return await bridge.call_rpc(
            uid,
            "fs.listDir",
            {"path": tc_args.get("path", "."), "recursive": tc_args.get("recursive", False)},
        )
    elif method == "execute_command":
        return await bridge.call_rpc(
            uid,
            "shell.execute",
            {"command": tc_args.get("command", ""), "timeout": tc_args.get("timeout", 60)},
        )
    elif method == "grep_search":
        return await bridge.call_rpc(
            uid,
            "fs.grepSearch",
            {"query": tc_args.get("query", ""), "path": tc_args.get("path", ".")},
        )
    elif method == "find_by_name":
        return await bridge.call_rpc(
            uid,
            "fs.findByName",
            {"pattern": tc_args.get("pattern", "*"), "path": tc_args.get("path", ".")},
        )
    elif method == "stop_process":
        return {"success": True, "message": "已向本地 Bridge 节点发送停止信号"}
    else:
        return {"success": False, "error": f"Bridge 模式暂不支持工具: {method}"}


# ============================================================================
# 微秒级抢占式中断与插话控制器 (PreemptiveController)
# ============================================================================


class PreemptiveController:
    """微秒级抢占式中断与插话控制器：管理活跃子任务、PTY 信号与半截上下文恢复"""

    def __init__(
        self,
        session_id: str = "default",
        steering_queue: Optional[asyncio.Queue[str]] = None,
    ) -> None:
        self.session_id: str = str(session_id)
        self.preempt_event: asyncio.Event = asyncio.Event()
        self.abort_event: asyncio.Event = asyncio.Event()
        self.active_subtasks: set[asyncio.Task[Any]] = set()
        self.active_pty_session_ids: set[str] = set()
        self.steering_queue: asyncio.Queue[str] = steering_queue or asyncio.Queue()
        self.partial_step_text: str = ""
        self.partial_stdout: str = ""
        self.completed_tool_results: list[dict[str, Any]] = []

    def append_partial_text(self, text: str) -> None:
        if text:
            self.partial_step_text += text

    def append_partial_stdout(self, line: str) -> None:
        if line:
            if self.partial_stdout:
                self.partial_stdout += "\n" + line
            else:
                self.partial_stdout = line

    def record_completed_tool(self, tool_name: str, result: Any) -> None:
        self.completed_tool_results.append({"name": tool_name, "result": result})

    def _interrupt_active_ptys(self) -> None:
        if not self.active_pty_session_ids:
            return
        try:
            from services.terminal_manager import TerminalManager

            tm = TerminalManager.get_instance()
            for pty_sid in list(self.active_pty_session_ids):
                pty_sess = tm.get_session(pty_sid)
                if pty_sess and pty_sess.is_alive():
                    pty_sess.write(b"\x03")
                    logger.info("已向活跃 PTY 会话 [%s] 发送 SIGINT (\\x03)", pty_sid)
        except Exception as exc:
            logger.warning("中断 PTY 会话异常: %s", exc)

    def _cancel_active_subtasks(self) -> None:
        for task in list(self.active_subtasks):
            if not task.done():
                task.cancel()

    def trigger_steer(self, text: str, preempt: bool = True) -> bool:
        """投递实时插话指令，并在 preempt=True 时微秒级中断当前慢工具或流"""
        cleaned = str(text).strip() if text else ""
        if cleaned:
            self.steering_queue.put_nowait(cleaned)
        if preempt:
            self.preempt_event.set()
            self._interrupt_active_ptys()
            self._cancel_active_subtasks()
        return True

    def trigger_abort(self) -> bool:
        """强制终止当前会话所有正在执行的子任务与 PTY 前台进程"""
        self.abort_event.set()
        self.preempt_event.set()
        self._interrupt_active_ptys()
        self._cancel_active_subtasks()
        return True

    def has_steer(self) -> bool:
        """检查是否有待处理的插话指令"""
        return not self.steering_queue.empty()

    def consume_steer(self) -> Optional[str]:
        """弹出并返回单条待处理的插话指令"""
        try:
            return self.steering_queue.get_nowait()
        except asyncio.QueueEmpty:
            return None

    def drain_steering_messages(self) -> list[str]:
        """排空并返回队列中所有待执行的插话文本"""
        messages: list[str] = []
        while not self.steering_queue.empty():
            try:
                item = self.steering_queue.get_nowait()
                if item and str(item).strip():
                    messages.append(str(item).strip())
            except asyncio.QueueEmpty:
                break
        return messages

    def build_recovery_anchor(
        self,
        step: int,
        step_text: Optional[str] = None,
        partial_stdout: Optional[str] = None,
    ) -> str:
        """组装系统恢复锚点：[Interrupted by user at step {step} | Partial output preserved: {snippet}]"""
        txt = step_text if step_text is not None else self.partial_step_text
        out = partial_stdout if partial_stdout is not None else self.partial_stdout
        parts: list[str] = []
        if txt and txt.strip():
            parts.append(txt.strip())
        if out and out.strip():
            parts.append(out.strip())
        if self.completed_tool_results:
            done_names = ",".join(t["name"] for t in self.completed_tool_results)
            parts.append(f"completed_tools=[{done_names}]")
        snippet = " | ".join(parts) if parts else "none"
        if len(snippet) > 600:
            snippet = snippet[:600] + "..."
        return f"[Interrupted by user at step {step} | Partial output preserved: {snippet}]"

    def clear_preempt(self) -> None:
        """完成抢占恢复后重置单步抢占标志与半截缓冲"""
        self.preempt_event.clear()
        self.partial_step_text = ""
        self.partial_stdout = ""
        self.completed_tool_results.clear()

    async def run_preemptible(
        self,
        coro: Awaitable[Any],
        timeout: Optional[float] = None,
    ) -> Any:
        """在受抢占监控的独立 Task 中运行协程，收到 preempt_event 时微秒级中断"""
        if self.abort_event.is_set():
            if inspect.iscoroutine(coro):
                coro.close()
            raise asyncio.CancelledError("Task aborted")
        if self.preempt_event.is_set():
            if inspect.iscoroutine(coro):
                coro.close()
            raise ToolPreemptedError("Preempted before execution")

        task: asyncio.Task[Any] = asyncio.ensure_future(coro)
        self.active_subtasks.add(task)
        preempt_wait_task: asyncio.Task[Any] = asyncio.create_task(self.preempt_event.wait())
        try:
            done, _ = await asyncio.wait(
                {task, preempt_wait_task},
                timeout=timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                # 超时
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
                raise asyncio.TimeoutError(f"工具执行超时 ({timeout}s)")

            if task in done and not task.cancelled():
                return task.result()

            # 抢占或取消触发
            if not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass

            if self.abort_event.is_set():
                raise asyncio.CancelledError("Task aborted")
            if self.preempt_event.is_set():
                raise ToolPreemptedError("Preempted during execution")
            raise asyncio.CancelledError()
        except asyncio.CancelledError:
            if not task.done():
                task.cancel()
            if self.preempt_event.is_set() and not self.abort_event.is_set():
                raise ToolPreemptedError("Preempted during execution")
            raise
        finally:
            self.active_subtasks.discard(task)
            if not preempt_wait_task.done():
                preempt_wait_task.cancel()


# ============================================================================
# 双模态有限状态机 (AgentStateMachine)
# ============================================================================


class AgentStateMachine:
    """抢占式双模态有限状态机：驱动 PLAN/ACT 模式门控、状态跃迁校验与工具统一派发"""

    PLAN_MODE_REJECT_MESSAGE = (
        "[Plan Mode Gate] 当前处于只读规划模式 (PLANNING)，禁止执行修改类工具。"
        "请仅使用只读工具探索代码，并在完成分析后输出 <proposed_plan>...</proposed_plan> "
        "请求用户批准切换到 ACT 模式。"
    )

    PROPOSED_PLAN_REGEX = re.compile(
        r"<proposed_plan>([\s\S]*?)</proposed_plan>",
        re.IGNORECASE,
    )

    VALID_STATE_TRANSITIONS: dict[AgentLifecycleState, set[AgentLifecycleState]] = {
        AgentLifecycleState.IDLE: {
            AgentLifecycleState.IDLE,
            AgentLifecycleState.PLANNING,
            AgentLifecycleState.COMPILING_CONTEXT,
            AgentLifecycleState.STREAMING_LLM,
            AgentLifecycleState.INTERRUPTED,
            AgentLifecycleState.COMPLETED,
        },
        AgentLifecycleState.PLANNING: {
            AgentLifecycleState.PLANNING,
            AgentLifecycleState.COMPILING_CONTEXT,
            AgentLifecycleState.STREAMING_LLM,
            AgentLifecycleState.EXECUTING_TOOLS,
            AgentLifecycleState.EVALUATING,
            AgentLifecycleState.AWAITING_PLAN_APPROVAL,
            AgentLifecycleState.INTERRUPTED,
            AgentLifecycleState.COMPLETED,
        },
        AgentLifecycleState.AWAITING_PLAN_APPROVAL: {
            AgentLifecycleState.AWAITING_PLAN_APPROVAL,
            AgentLifecycleState.COMPILING_CONTEXT,
            AgentLifecycleState.STREAMING_LLM,
            AgentLifecycleState.PLANNING,
            AgentLifecycleState.IDLE,
            AgentLifecycleState.INTERRUPTED,
            AgentLifecycleState.COMPLETED,
        },
        AgentLifecycleState.COMPILING_CONTEXT: {
            AgentLifecycleState.COMPILING_CONTEXT,
            AgentLifecycleState.PLANNING,
            AgentLifecycleState.STREAMING_LLM,
            AgentLifecycleState.INTERRUPTED,
            AgentLifecycleState.COMPLETED,
        },
        AgentLifecycleState.STREAMING_LLM: {
            AgentLifecycleState.STREAMING_LLM,
            AgentLifecycleState.PLANNING,
            AgentLifecycleState.EXECUTING_TOOLS,
            AgentLifecycleState.EVALUATING,
            AgentLifecycleState.AWAITING_PLAN_APPROVAL,
            AgentLifecycleState.COMPILING_CONTEXT,
            AgentLifecycleState.INTERRUPTED,
            AgentLifecycleState.COMPLETED,
        },
        AgentLifecycleState.EXECUTING_TOOLS: {
            AgentLifecycleState.EXECUTING_TOOLS,
            AgentLifecycleState.EVALUATING,
            AgentLifecycleState.PLANNING,
            AgentLifecycleState.COMPILING_CONTEXT,
            AgentLifecycleState.STREAMING_LLM,
            AgentLifecycleState.AWAITING_PLAN_APPROVAL,
            AgentLifecycleState.INTERRUPTED,
            AgentLifecycleState.COMPLETED,
        },
        AgentLifecycleState.EVALUATING: {
            AgentLifecycleState.EVALUATING,
            AgentLifecycleState.COMPILING_CONTEXT,
            AgentLifecycleState.PLANNING,
            AgentLifecycleState.STREAMING_LLM,
            AgentLifecycleState.EXECUTING_TOOLS,
            AgentLifecycleState.AWAITING_PLAN_APPROVAL,
            AgentLifecycleState.INTERRUPTED,
            AgentLifecycleState.COMPLETED,
        },
        AgentLifecycleState.INTERRUPTED: {
            AgentLifecycleState.INTERRUPTED,
            AgentLifecycleState.COMPILING_CONTEXT,
            AgentLifecycleState.PLANNING,
            AgentLifecycleState.STREAMING_LLM,
            AgentLifecycleState.IDLE,
            AgentLifecycleState.COMPLETED,
        },
        AgentLifecycleState.COMPLETED: {
            AgentLifecycleState.COMPLETED,
            AgentLifecycleState.IDLE,
            AgentLifecycleState.COMPILING_CONTEXT,
            AgentLifecycleState.PLANNING,
        },
    }

    _active_machines: dict[str, "AgentStateMachine"] = {}

    @classmethod
    def get_active(cls, session_id: str) -> Optional["AgentStateMachine"]:
        return cls._active_machines.get(str(session_id))

    def __init__(
        self,
        session_id: str = "default",
        mode: AgentRunMode | str = AgentRunMode.ACT,
        initial_state: Optional[AgentLifecycleState | str] = None,
        registry: Optional[ToolRegistry] = None,
        controller: Optional[PreemptiveController] = None,
        emitter: Optional[EnvelopeEmitter] = None,
    ) -> None:
        self.session_id: str = str(session_id)
        AgentStateMachine._active_machines[self.session_id] = self
        self.mode: AgentRunMode = (
            mode if isinstance(mode, AgentRunMode) else AgentRunMode(str(mode or "act"))
        )
        if initial_state is not None:
            self.state: AgentLifecycleState = (
                initial_state
                if isinstance(initial_state, AgentLifecycleState)
                else AgentLifecycleState(str(initial_state))
            )
        else:
            self.state = (
                AgentLifecycleState.PLANNING
                if self.mode == AgentRunMode.PLAN
                else AgentLifecycleState.IDLE
            )
        self.tool_registry: ToolRegistry = registry or tool_registry
        self.controller: PreemptiveController = controller or PreemptiveController(
            session_id=self.session_id
        )
        self.emitter: Optional[EnvelopeEmitter] = emitter
        self.transition_history: list[dict[str, Any]] = []
        self.proposed_plan_id: Optional[str] = None
        self.proposed_plan_content: Optional[str] = None

    def can_transition_to(self, target_state: AgentLifecycleState | str) -> bool:
        target = (
            target_state
            if isinstance(target_state, AgentLifecycleState)
            else AgentLifecycleState(str(target_state))
        )
        allowed = self.VALID_STATE_TRANSITIONS.get(self.state, set())
        return target in allowed

    def transition_to(
        self,
        target_state: AgentLifecycleState | str,
        reason: str = "",
        step: Optional[int] = None,
    ) -> dict[str, Any]:
        """执行合法性校验并推进状态机跃迁，非法跃迁抛出 InvalidStateTransitionError 并记录审计日志"""
        target = (
            target_state
            if isinstance(target_state, AgentLifecycleState)
            else AgentLifecycleState(str(target_state))
        )
        allowed = self.VALID_STATE_TRANSITIONS.get(self.state, set())
        if target not in allowed:
            logger.error(
                "[StateAudit] 会话 [%s] 非法状态跃迁拒绝: %s -> %s (reason=%s)",
                self.session_id,
                self.state.value,
                target.value,
                reason,
            )
            raise InvalidStateTransitionError(self.state, target, reason=reason)

        prev_state = self.state
        self.state = target
        record = {
            "session_id": self.session_id,
            "from_state": prev_state.value,
            "to_state": target.value,
            "reason": reason,
            "mode": self.mode.value,
            "step": step,
            "timestamp": int(time.time() * 1000),
        }
        self.transition_history.append(record)
        logger.info(
            "[StateAudit] 会话 [%s] 状态跃迁: %s -> %s (mode=%s, reason=%s)",
            self.session_id,
            prev_state.value,
            target.value,
            self.mode.value,
            reason,
        )
        return record

    def is_tool_mutating(
        self,
        tool_name: str,
        tool_args: Optional[dict[str, Any]] = None,
    ) -> bool:
        """判定工具是否具有副作用/修改属性"""
        if tool_name == "agent__ask_user":
            return False

        reg_tool = self.tool_registry.get(tool_name)
        if reg_tool is not None:
            if reg_tool.name == "workspace__dispatch_subagent":
                agent_type = str((tool_args or {}).get("agent_type", "explore")).lower()
                return agent_type != "explore"
            return reg_tool.mutating

        kind, _, method = ToolAdapter.parse_namespaced_tool(tool_name)
        if kind == "agent" and method == "ask_user":
            return False
        if kind == "workspace":
            read_only_methods = {
                "read_file",
                "list_dir",
                "grep_search",
                "find_by_name",
                "dispatch_subagent",
            }
            if method == "dispatch_subagent":
                agent_type = str((tool_args or {}).get("agent_type", "explore")).lower()
                return agent_type != "explore"
            return method not in read_only_methods
        return True

    def detect_proposed_plan(
        self,
        text: str,
        step: int = 1,
    ) -> Optional[dict[str, Any]]:
        """检测模型输出是否包含 <proposed_plan>...</proposed_plan>，若命中则提取计划并跃迁至 AWAITING_PLAN_APPROVAL"""
        if not text:
            return None
        match = self.PROPOSED_PLAN_REGEX.search(text)
        if not match:
            return None

        plan_body = match.group(1).strip()
        plan_id = f"plan_{uuid.uuid4().hex[:10]}"
        self.proposed_plan_id = plan_id
        self.proposed_plan_content = plan_body
        self.transition_to(
            AgentLifecycleState.AWAITING_PLAN_APPROVAL,
            reason="proposed_plan_detected",
            step=step,
        )
        return {
            "session_id": self.session_id,
            "plan_id": plan_id,
            "plan": plan_body,
            "step": step,
            "state": self.state.value,
        }

    def approve_plan(self, plan_id: Optional[str] = None) -> dict[str, Any]:
        """用户批准规划后切换至 ACT 模式并进入上下文编译态"""
        self.mode = AgentRunMode.ACT
        return self.transition_to(
            AgentLifecycleState.COMPILING_CONTEXT,
            reason=f"plan_approved:{plan_id or self.proposed_plan_id or 'latest'}",
        )

    def reject_plan(self, feedback: Optional[str] = None) -> dict[str, Any]:
        """用户驳回规划后保持在 PLAN 模式并回到 PLANNING 状态重新规划"""
        self.mode = AgentRunMode.PLAN
        if self.state == AgentLifecycleState.AWAITING_PLAN_APPROVAL:
            return self.transition_to(
                AgentLifecycleState.PLANNING,
                reason=f"plan_rejected:{feedback or 'no_feedback'}",
            )
        return {"state": self.state.value, "mode": self.mode.value}

    async def execute_tool_call(
        self,
        tool_name: str,
        tool_args: Optional[dict[str, Any]] = None,
        workspace_root: str = ".",
        user_id: str = "default_user",
        session_id: Optional[str] = None,
        tool_meta: Optional[dict[str, Any]] = None,
        skill_engine: Optional[Any] = None,
        mcp_client_manager: Optional[Any] = None,
        controller: Optional[PreemptiveController] = None,
        step: int = 1,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """统一执行层：执行 Plan Mode 只读硬门控、Bridge 路由、声明式工具调用与微秒级抢占保护"""
        args = tool_args if isinstance(tool_args, dict) else {}
        active_controller = controller or self.controller
        effective_session_id = str(session_id or self.session_id)

        # 1. Plan Mode 硬门控：处于 PLANNING 状态或 plan 模式时拦截一切 mutating=True 工具
        if (
            self.state == AgentLifecycleState.PLANNING
            or self.mode == AgentRunMode.PLAN
        ) and self.is_tool_mutating(tool_name, args):
            logger.info(
                "[PlanModeGate] 会话 [%s] 在 PLANNING 模式下拦截写工具调用: %s",
                effective_session_id,
                tool_name,
            )
            return {
                "success": False,
                "error": self.PLAN_MODE_REJECT_MESSAGE,
            }

        # 2. 在 ACT 模式下更新状态为 EXECUTING_TOOLS
        if (
            self.mode == AgentRunMode.ACT
            and self.state != AgentLifecycleState.PLANNING
            and self.state != AgentLifecycleState.EXECUTING_TOOLS
            and self.can_transition_to(AgentLifecycleState.EXECUTING_TOOLS)
        ):
            self.transition_to(
                AgentLifecycleState.EXECUTING_TOOLS,
                reason=f"execute:{tool_name}",
                step=step,
            )

        reg_tool = self.tool_registry.get(tool_name)

        async def _invoke() -> Any:
            if reg_tool is not None:
                _, _, method = ToolAdapter.parse_namespaced_tool(reg_tool.name)
                if workspace_root.startswith("bridge://") and reg_tool.supports_bridge:
                    return await _execute_bridge_rpc(
                        method=method,
                        tc_args=args,
                        workspace_root=workspace_root,
                        user_id=user_id,
                    )
                call_kwargs = dict(kwargs)
                if "emitter" not in call_kwargs and self.emitter is not None:
                    call_kwargs["emitter"] = self.emitter
                res = reg_tool.handler(
                    workspace_root=workspace_root,
                    tc_args=args,
                    user_id=user_id,
                    session_id=effective_session_id,
                    controller=active_controller,
                    step=step,
                    **call_kwargs,
                )
                if inspect.isawaitable(res):
                    return await res
                return res

            # 检查未在 tool_registry 中显式注册但带 workspace__ 前缀的方法
            kind, target, method = ToolAdapter.parse_namespaced_tool(tool_name)
            if (tool_meta and tool_meta.get("type") == "workspace") or kind == "workspace":
                if workspace_root.startswith("bridge://"):
                    return await _execute_bridge_rpc(
                        method=method,
                        tc_args=args,
                        workspace_root=workspace_root,
                        user_id=user_id,
                    )
                raise AppException(
                    code=ErrorCode.NOT_FOUND,
                    message=f"未找到工作区操作方法: {method}",
                )

            if tool_meta and tool_meta.get("type") == "skill":
                from services.skill_engine import skill_engine as default_skill_engine

                eng = skill_engine or default_skill_engine
                return await eng.execute_skill(
                    skill=tool_meta["data"],
                    arguments=args,
                    timeout=30,
                )

            if tool_meta and tool_meta.get("type") == "mcp":
                from services.mcp_client import mcp_client_manager as default_mcp_manager

                mgr = mcp_client_manager or default_mcp_manager
                return await mgr.call_tool(
                    config=tool_meta["server"],
                    tool_name=tool_meta["raw_name"],
                    arguments=args,
                )

            raise AppException(
                code=ErrorCode.NOT_FOUND,
                message=f"未支持的工具类型: {tool_name}",
            )

        timeout_sec = reg_tool.timeout_sec if reg_tool is not None else 30.0
        try:
            result = await active_controller.run_preemptible(_invoke(), timeout=timeout_sec)
            active_controller.record_completed_tool(tool_name, result)
            return result
        except ToolPreemptedError:
            if self.can_transition_to(AgentLifecycleState.INTERRUPTED):
                self.transition_to(
                    AgentLifecycleState.INTERRUPTED,
                    reason=f"preempted_during_tool:{tool_name}",
                    step=step,
                )
            anchor = active_controller.build_recovery_anchor(step=step)
            logger.info(
                "会话 [%s] 工具 [%s] 被微秒级抢占中断，恢复锚点: %s",
                effective_session_id,
                tool_name,
                anchor,
            )
            return {
                "success": False,
                "preempted": True,
                "partial_stdout": active_controller.partial_stdout,
                "recovery_anchor": anchor,
                "error": anchor,
            }
