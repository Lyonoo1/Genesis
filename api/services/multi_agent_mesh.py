import asyncio
import fnmatch
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal, Optional, Union

from core.exceptions import AppException, ErrorCode
from models.schemas.chat import SSEEventName
from models.schemas.stream_envelope import (
    EnvelopeEmitter,
    StreamChannel,
    StreamEnvelope,
)
from services.agent_state_machine import PreemptiveController, tool_registry
from services.llm_adapter import LLMAdapter, StreamChunk, llm_adapter
from services.tool_adapter import ToolAdapter
from services.workspace_tool_executor import WorkspaceToolExecutor

logger = logging.getLogger("genesis.multi_agent_mesh")


# ============================================================================
# 1. 作用域路径与通配符匹配引擎
# ============================================================================


def normalize_rel_path(path: str) -> str:
    """标准化相对路径：转换为正斜杠，去除前导 ./ 或 /"""
    p = str(path or "").strip().replace("\\", "/")
    if p.startswith("./"):
        p = p[2:]
    return p.lstrip("/")


def glob_to_regex(pattern: str) -> re.Pattern:
    """将 glob 通配符转换为精确正则表达式 (支持 ** 跨层级匹配)"""
    pat = normalize_rel_path(pattern)
    if pat in ("*", "**", "**/*"):
        return re.compile(r"^.*$")

    if pat.endswith("/**"):
        prefix = pat[:-3]
        prefix_re = glob_to_regex(prefix).pattern[1:-1]
        return re.compile(rf"^{prefix_re}(?:/.*)?$")

    i, n = 0, len(pat)
    res = []
    while i < n:
        c = pat[i]
        if c == "*":
            if i + 1 < n and pat[i + 1] == "*":
                i += 2
                if i < n and pat[i] == "/":
                    i += 1
                    res.append("(?:.*/)?")
                else:
                    res.append(".*")
            else:
                i += 1
                res.append("[^/]*")
        elif c == "?":
            i += 1
            res.append("[^/]")
        elif c in r"\.+^${}()|[]":
            res.append(re.escape(c))
            i += 1
        else:
            res.append(c)
            i += 1
    return re.compile(f"^{''.join(res)}$")


def patterns_overlap(pattern1: str, pattern2: str) -> bool:
    """静态判定两个路径或 glob 模式是否存在交集 (Overlap Detection)"""
    pat1 = normalize_rel_path(pattern1)
    pat2 = normalize_rel_path(pattern2)

    if pat1 == pat2:
        return True
    if pat1 in ("*", "**", "**/*") or pat2 in ("*", "**", "**/*"):
        return True

    has1 = any(c in pat1 for c in "*?[")
    has2 = any(c in pat2 for c in "*?[")

    if not has1 and not has2:
        return pat1 == pat2
    if not has1:
        return bool(glob_to_regex(pat2).match(pat1))
    if not has2:
        return bool(glob_to_regex(pat1).match(pat2))

    segs1, segs2 = pat1.split("/"), pat2.split("/")

    def _match(i: int, j: int) -> bool:
        if i >= len(segs1) and j >= len(segs2):
            return True
        if i < len(segs1) and segs1[i] == "**":
            if _match(i + 1, j):
                return True
            if j < len(segs2) and _match(i, j + 1):
                return True
            return False
        if j < len(segs2) and segs2[j] == "**":
            if _match(i, j + 1):
                return True
            if i < len(segs1) and _match(i + 1, j):
                return True
            return False
        if i < len(segs1) and j < len(segs2):
            s1, s2 = segs1[i], segs2[j]
            if s1 == s2 or s1 == "*" or s2 == "*":
                return _match(i + 1, j + 1)
            if fnmatch.fnmatch(s1, s2) or fnmatch.fnmatch(s2, s1):
                return _match(i + 1, j + 1)
            return False
        return False

    return _match(0, 0)


# ============================================================================
# 2. 异常定义
# ============================================================================


class LockConflictError(RuntimeError):
    """并发写作用域锁冲突异常"""

    def __init__(
        self,
        agent_id: str,
        conflicting_agent_id: str,
        conflict_scope: str,
        message: str = "",
    ):
        self.agent_id = agent_id
        self.conflicting_agent_id = conflicting_agent_id
        self.conflict_scope = conflict_scope
        msg = (
            message
            or f"锁冲突: 作用域 '{conflict_scope}' 已被代理 [{conflicting_agent_id}] 独占占用"
        )
        super().__init__(msg)


class ScopeViolationError(PermissionError):
    """写作用域越权异常"""

    def __init__(
        self,
        agent_id: str,
        path: str,
        write_scope: list[str],
        message: str = "",
    ):
        self.agent_id = agent_id
        self.path = path
        self.write_scope = list(write_scope)
        msg = (
            message
            or f"越权错误: 目标路径 '{path}' 超出子代理 [{agent_id}] 已声明的写作用域 {write_scope}"
        )
        super().__init__(msg)


# ============================================================================
# 3. 并发写作用域锁管理器 (WorkspaceLockManager)
# ============================================================================


class WorkspaceLockManager:
    """工作区并发写作用域读写锁管理器 (Async RWLock)

    1. 读写分离：
       - explore / verify 申请共享读锁 (Shared Read Lock)，允许多个只读代理同时读取任意文件
       - code_worker 启动时对其声明的 write_scope 申请排他写锁 (Exclusive Scope Lock)
    2. 作用域硬拦截：
       - code_worker 调用写/删/改工具时二次校验目标路径是否落在自身 write_scope 内
       - 超出自身 write_scope 立即拒绝写入并抛出越权错误
    3. 冲突检测与排队：
       - 两个 code_worker 的 write_scope 存在交集时支持带超时的异步排队等待
       - 超时或立即模式返回冲突详情（含占用锁的 agent_id）
    4. 锁释放与唤醒：
       - 代理结束、失败或 close_agent 时释放所有锁并唤醒等待协程
    """

    def __init__(self) -> None:
        # agent_id -> list of glob patterns for exclusive write
        self._write_locks: dict[str, list[str]] = {}
        # agent_id -> list of glob patterns for shared read
        self._read_locks: dict[str, list[str]] = {}
        self._lock = asyncio.Lock()
        self._condition = asyncio.Condition(self._lock)

    def matches_scope(self, pattern: str, path: str) -> bool:
        """检查指定相对路径是否命中 glob 模式"""
        clean_path = normalize_rel_path(path)
        regex = glob_to_regex(pattern)
        return bool(regex.match(clean_path))

    def matches_any(self, patterns: list[str], path: str) -> bool:
        """检查路径是否命中任意模式"""
        clean_path = normalize_rel_path(path)
        for pat in patterns:
            if self.matches_scope(pat, clean_path):
                return True
        return False

    def scopes_overlap(self, p1: str, p2: str) -> bool:
        return patterns_overlap(p1, p2)

    def find_write_conflict(
        self, write_scope: list[str], requesting_agent_id: str
    ) -> Optional[tuple[str, str]]:
        """检查是否有其他 agent 持有重叠的写作用域。若有返回 (conflicting_agent_id, conflict_pattern)"""
        for holder_id, holder_scopes in self._write_locks.items():
            if holder_id == requesting_agent_id:
                continue
            for s1 in write_scope:
                for s2 in holder_scopes:
                    if self.scopes_overlap(s1, s2):
                        return (holder_id, s1)
        return None

    async def acquire_read(
        self, agent_id: str, paths: Optional[list[str]] = None
    ) -> bool:
        """申请共享读锁 (Shared Read Lock)"""
        clean_paths = [normalize_rel_path(p) for p in (paths or ["*"])]
        async with self._condition:
            self._read_locks[agent_id] = clean_paths
            return True

    async def acquire_write(
        self,
        agent_id: str,
        write_scope: list[str],
        timeout: Optional[float] = None,
    ) -> bool:
        """申请排他写作用域锁 (Exclusive Scope Lock)"""
        if not write_scope:
            raise ValueError(f"代理 [{agent_id}] 必须指定非空的 write_scope")

        clean_scopes = [normalize_rel_path(p) for p in write_scope if str(p).strip()]
        if not clean_scopes:
            raise ValueError(f"代理 [{agent_id}] 的 write_scope 经标准化后为空")

        async with self._condition:
            conflict = self.find_write_conflict(clean_scopes, agent_id)
            if conflict is None:
                self._write_locks[agent_id] = clean_scopes
                logger.info("代理 [%s] 成功获取排他写作用域: %s", agent_id, clean_scopes)
                return True

            if timeout is None or timeout <= 0:
                conflicting_agent, conflict_pat = conflict
                logger.warning(
                    "代理 [%s] 申请写作用域锁与代理 [%s] 冲突 (scope: %s)",
                    agent_id,
                    conflicting_agent,
                    conflict_pat,
                )
                raise LockConflictError(
                    agent_id=agent_id,
                    conflicting_agent_id=conflicting_agent,
                    conflict_scope=conflict_pat,
                    message=f"锁冲突: 作用域 '{conflict_pat}' 已被代理 [{conflicting_agent}] 独占锁住",
                )

            # 排队等待锁释放
            t_end = time.time() + timeout
            while conflict is not None:
                remaining = t_end - time.time()
                if remaining <= 0:
                    conflicting_agent, conflict_pat = conflict
                    raise LockConflictError(
                        agent_id=agent_id,
                        conflicting_agent_id=conflicting_agent,
                        conflict_scope=conflict_pat,
                        message=f"锁冲突: 等待写作用域 '{conflict_pat}' 超时 ({timeout}s)，仍被代理 [{conflicting_agent}] 独占占用",
                    )
                try:
                    await asyncio.wait_for(self._condition.wait(), timeout=remaining)
                except asyncio.TimeoutError:
                    pass
                conflict = self.find_write_conflict(clean_scopes, agent_id)

            self._write_locks[agent_id] = clean_scopes
            logger.info("代理 [%s] 排队等待后成功获得写作用域: %s", agent_id, clean_scopes)
            return True

    def validate_write(self, agent_id: str, path: str) -> bool:
        """二次校验写权限与作用域，越权立即抛出 ScopeViolationError"""
        clean_path = normalize_rel_path(path)
        scopes = self._write_locks.get(agent_id)
        if scopes is None:
            raise ScopeViolationError(
                agent_id=agent_id,
                path=path,
                write_scope=[],
                message=f"越权错误: 代理 [{agent_id}] 未持有任何排他写锁，严禁修改文件 '{path}'",
            )

        if not self.matches_any(scopes, clean_path):
            raise ScopeViolationError(
                agent_id=agent_id,
                path=path,
                write_scope=scopes,
                message=f"越权错误: 目标路径 '{path}' 超出代理 [{agent_id}] 已声明的写作用域 {scopes}",
            )
        return True

    def is_write_allowed(self, agent_id: str, path: str) -> tuple[bool, str]:
        """安全查询是否允许写入，返回 (allowed, reason_if_denied)"""
        try:
            self.validate_write(agent_id, path)
            return True, ""
        except ScopeViolationError as e:
            return False, str(e)

    def release(self, agent_id: str) -> None:
        """同步释放指定代理持有的全部锁并尝试唤醒等待者"""
        removed_write = self._write_locks.pop(agent_id, None)
        removed_read = self._read_locks.pop(agent_id, None)
        if removed_write or removed_read:
            logger.info("代理 [%s] 已释放持有的锁 (write: %s, read: %s)", agent_id, removed_write, bool(removed_read))

        async def _notify() -> None:
            try:
                async with self._condition:
                    self._condition.notify_all()
            except Exception:
                pass

        try:
            loop = asyncio.get_running_loop()
            loop.create_task(_notify())
        except RuntimeError:
            pass

    async def release_async(self, agent_id: str) -> None:
        """异步释放指定代理持有的全部锁并广播通知"""
        async with self._condition:
            self._write_locks.pop(agent_id, None)
            self._read_locks.pop(agent_id, None)
            self._condition.notify_all()

    def has_locks(self, agent_id: str) -> bool:
        return agent_id in self._write_locks or agent_id in self._read_locks

    def get_active_locks(self) -> dict[str, Any]:
        return {
            "write_locks": {k: list(v) for k, v in self._write_locks.items()},
            "read_locks": {k: list(v) for k, v in self._read_locks.items()},
        }

    def clear_all(self) -> None:
        self._write_locks.clear()
        self._read_locks.clear()


# 全局工作区锁管理器单例
workspace_lock_manager = WorkspaceLockManager()


# ============================================================================
# 4. 子代理元数据模型 (SubagentInfo)
# ============================================================================


@dataclass
class SubagentInfo:
    agent_id: str
    parent_call_id: Optional[str]
    session_id: str
    mode: str  # "explore" | "verify" | "code_worker"
    task: str
    write_scope: list[str] = field(default_factory=list)
    status: str = "RUNNING"  # "RUNNING" | "COMPLETED" | "FAILED" | "TERMINATED"
    controller: Optional[PreemptiveController] = None
    task_handle: Optional[asyncio.Task[Any]] = None
    start_time: float = field(default_factory=time.time)
    end_time: Optional[float] = None
    modified_files: set[str] = field(default_factory=set)
    steps_taken: int = 0
    summary: str = ""
    error: Optional[str] = None
    error_code: Optional[str] = None
    latest_thinking: str = ""
    latest_preview: str = ""


# ============================================================================
# 5. 异步非阻塞多代理网格 (MultiAgentMesh)
# ============================================================================


class MultiAgentMesh:
    """Codex 对齐的异步非阻塞多代理网格引擎 (MultiAgentMesh)

    核心异步原语：
    - workspace__spawn_agent: 非阻塞派发后台子代理，立即返回 agent_id
    - workspace__wait_agent: 基于 asyncio 等待子代理，返回结构化汇报与进行中快照
    - workspace__send_input: 实时向运行中子代理注入纠偏指令 (支持 PreemptiveController 抢占)
    - workspace__close_agent: 单点终止子代理并即时释放全部作用域锁
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

    CODE_WORKER_ALLOWED_TOOLS = {
        "workspace__read_file",
        "workspace__grep_search",
        "workspace__find_by_name",
        "workspace__list_dir",
        "workspace__execute_command",
        "workspace__write_file",
        "workspace__edit_file",
        "workspace__delete_file",
    }

    def __init__(
        self,
        llm: Optional[LLMAdapter] = None,
        lock_manager: Optional[WorkspaceLockManager] = None,
    ) -> None:
        self.llm_adapter = llm or llm_adapter
        self.lock_manager = lock_manager or workspace_lock_manager
        self.agents: dict[str, SubagentInfo] = {}
        self._counter: int = 0

    def get_agent(self, agent_id: str) -> Optional[SubagentInfo]:
        return self.agents.get(agent_id)

    def _get_allowed_tool_names(self, mode: str) -> set[str]:
        if mode == "code_worker":
            return self.CODE_WORKER_ALLOWED_TOOLS
        elif mode == "verify":
            return self.VERIFY_ALLOWED_TOOLS
        return self.EXPLORE_ALLOWED_TOOLS

    def _get_openai_tools(self, mode: str) -> list[dict[str, Any]]:
        allowed = self._get_allowed_tool_names(mode)
        return [
            bt
            for bt in ToolAdapter.BUILTIN_WORKSPACE_TOOLS
            if bt.get("function", {}).get("name") in allowed
        ]

    def _get_system_prompt(
        self,
        mode: str,
        workspace_root: str,
        write_scope: Optional[list[str]] = None,
    ) -> str:
        display_root = workspace_root
        if workspace_root.startswith("bridge://"):
            parts = workspace_root[len("bridge://") :].split("::", 1)
            display_root = parts[1] if len(parts) > 1 else "."

        if mode == "explore":
            return (
                "你是 Genesis 代码库探索与架构分析子代理 (Explore Subagent)。\n"
                f"当前项目物理工作区绝对路径：'{display_root}'。\n"
                "你的任务：独立在代码库中检索、调研与分析，解答主 Agent 提出的具体代码或架构问题。\n\n"
                "【严格执行规范】\n"
                "1. 只读权限：你只拥有只读探索工具（read_file, grep_search, find_by_name, list_dir）。严禁尝试修改或执行文件。\n"
                "2. 聚焦核心：直接查阅最核心的文件定义、引用链路与实现。\n"
                "3. 详尽报告：调查完毕后，直接输出结构清晰、信息详尽的总结分析报告。"
            )
        elif mode == "verify":
            return (
                "你是 Genesis 测试验证与排查子代理 (Verify Subagent)。\n"
                f"当前项目物理工作区绝对路径：'{display_root}'。\n"
                "你的任务：独立运行测试命令、分析输出、排查报错并精确定位问题根因。\n\n"
                "【严格执行规范】\n"
                "1. 权限边界：你仅可使用只读文件工具和命令执行工具（execute_command, read_file, grep_search, find_by_name, list_dir）。严禁修改或删除文件。\n"
                "2. 报错定位：运行测试并分析控制台输出，定位到具体出错的文件行号、异常原因与修复建议。\n"
                "3. 详尽报告：调查完毕后，直接输出清晰排查报告。"
            )
        else:  # code_worker
            scope_str = ", ".join(write_scope) if write_scope else "未声明"
            return (
                "你是 Genesis 代码变更与工程实现子代理 (Code Worker Subagent)。\n"
                f"当前项目物理工作区绝对路径：'{display_root}'。\n"
                f"已授权排他写作用域 (Write Scope)：[{scope_str}]。\n\n"
                "【严格执行规范】\n"
                "1. 作用域硬限制：你对文件系统的修改（write_file, edit_file, delete_file）严格限制在已声明的 write_scope 范围内，严禁越权修改作用域之外的文件。\n"
                "2. 局部精准编辑：优先使用 edit_file 进行精确局部替换，避免全量覆写。\n"
                "3. 变更报告：完成修改后，清晰汇报已修改的文件列表、核心逻辑变更与自测验证结论。"
            )

    async def spawn_agent(
        self,
        task: str,
        mode: Literal["explore", "verify", "code_worker"] = "explore",
        fork_context: bool = False,
        write_scope: Optional[list[str]] = None,
        workspace_root: str = ".",
        session_id: str = "default",
        parent_emitter: Optional[EnvelopeEmitter] = None,
        parent_controller: Optional[PreemptiveController] = None,
        parent_call_id: Optional[str] = None,
        model: str = "gpt-4o",
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        provider: Optional[str] = None,
        parent_messages: Optional[list[dict[str, Any]]] = None,
        max_steps: int = 12,
        user_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """异步非阻塞派发后台子代理，立即向主 Agent 返回 RUNNING 状态"""
        if mode not in ("explore", "verify", "code_worker"):
            return {
                "success": False,
                "error": f"不支持的子代理模式: {mode} (仅支持 explore, verify, code_worker)",
            }

        # 统一凭据兜底解析：即使调用方未透传 api_key，也自动回查用户配置库补齐
        from services.agent_guard import resolve_effective_model_credentials

        resolved = resolve_effective_model_credentials(
            user_id=user_id,
            model=model,
            api_key=api_key,
            base_url=base_url,
            provider=provider,
        )
        effective_model = resolved["model"]
        effective_api_key = resolved["api_key"]
        effective_base_url = resolved["base_url"]
        effective_provider = resolved["provider"]

        self._counter += 1
        agent_id = f"subagent_{self._counter}_{uuid.uuid4().hex[:8]}"
        clean_scopes = [normalize_rel_path(p) for p in (write_scope or []) if str(p).strip()]

        # 1. 锁申请与冲突校验
        if mode == "code_worker":
            if not clean_scopes:
                return {
                    "success": False,
                    "error": "code_worker 模式必须声明非空的 write_scope 列表 (如 ['src/auth/**', 'tests/*.py'])",
                }
            try:
                await self.lock_manager.acquire_write(
                    agent_id=agent_id, write_scope=clean_scopes, timeout=0
                )
            except LockConflictError as exc:
                logger.warning("派发子代理 [%s] 发生锁冲突: %s", agent_id, exc)
                return {
                    "success": False,
                    "status": "CONFLICT",
                    "agent_id": agent_id,
                    "conflicting_agent_id": exc.conflicting_agent_id,
                    "conflict_scope": exc.conflict_scope,
                    "error": str(exc),
                }
        else:
            await self.lock_manager.acquire_read(agent_id=agent_id)

        # 2. 构造子代理运行态元数据与内部抢占控制器
        sub_controller = PreemptiveController(session_id=agent_id)
        info = SubagentInfo(
            agent_id=agent_id,
            parent_call_id=parent_call_id,
            session_id=session_id,
            mode=mode,
            task=task,
            write_scope=clean_scopes,
            status="RUNNING",
            controller=sub_controller,
            start_time=time.time(),
        )
        self.agents[agent_id] = info

        # 3. 准备独立上下文（fork_context 克隆或纯净沙箱）
        system_prompt = self._get_system_prompt(mode, workspace_root, clean_scopes)
        if fork_context and parent_messages:
            cloned_messages: list[dict[str, Any]] = [
                dict(m)
                for m in parent_messages
                if m.get("role") in ("system", "user", "assistant")
            ]
            cloned_messages.append(
                {"role": "user", "content": f"【子代理委派任务 ({mode})】\n{task}"}
            )
            initial_messages = cloned_messages
        else:
            initial_messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": task},
            ]

        # 4. 在后台独立 Task 中启动子代理循环
        worker_coro = self._subagent_worker_loop(
            info=info,
            workspace_root=workspace_root,
            initial_messages=initial_messages,
            model=effective_model,
            api_key=effective_api_key,
            base_url=effective_base_url,
            provider=effective_provider,
            parent_emitter=parent_emitter,
            parent_controller=parent_controller,
            max_steps=max_steps,
        )
        task_handle = asyncio.create_task(worker_coro)
        info.task_handle = task_handle

        # 5. 绑定到父会话 PreemptiveController 生命周期中（连带取消防护）
        if parent_controller is not None:
            parent_controller.active_subtasks.add(task_handle)

        logger.info(
            "成功派发后台子代理 [%s] (mode=%s, parent_call_id=%s)",
            agent_id,
            mode,
            parent_call_id,
        )

        # 6. 非阻塞立即返回
        return {
            "success": True,
            "agent_id": agent_id,
            "status": "RUNNING",
            "mode": mode,
            "write_scope": clean_scopes if mode == "code_worker" else None,
            "parent_call_id": parent_call_id,
        }

    async def _subagent_worker_loop(
        self,
        info: SubagentInfo,
        workspace_root: str,
        initial_messages: list[dict[str, Any]],
        model: str,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        provider: Optional[str] = None,
        parent_emitter: Optional[EnvelopeEmitter] = None,
        parent_controller: Optional[PreemptiveController] = None,
        max_steps: int = 8,
    ) -> None:
        """后台子代理执行工作协程"""
        agent_id = info.agent_id
        parent_call_id = info.parent_call_id
        controller = info.controller
        allowed_tools = self._get_openai_tools(info.mode)
        allowed_tool_names = self._get_allowed_tool_names(info.mode)
        sub_messages = list(initial_messages)

        step = 1
        final_summary: str = ""

        try:
            # 广播初始 progress 事件
            if parent_emitter:
                parent_emitter.emit_sse(
                    event="subagent_progress",
                    payload={
                        "agent_id": agent_id,
                        "agent_type": info.mode,
                        "mode": info.mode,
                        "task_prompt": info.task,
                        "step": 0,
                        "status": "started",
                        "summary_preview": f"子代理启动 [{info.mode}]",
                    },
                    channel=StreamChannel.CHAT,
                    agent_id=agent_id,
                    parent_call_id=parent_call_id,
                )

            while step <= max_steps:
                info.steps_taken = step
                if controller and controller.abort_event.is_set():
                    info.status = "TERMINATED"
                    break

                # 消费待处理的纠偏指令
                if controller:
                    steered_msgs = controller.drain_steering_messages()
                    if steered_msgs:
                        steered_text = "\n\n".join(steered_msgs)
                        sub_messages.append(
                            {
                                "role": "user",
                                "content": f"【用户实时纠偏转向指令】\n{steered_text}",
                            }
                        )
                        logger.info("子代理 [%s] Step %d 注入纠偏指令: %s", agent_id, step, steered_text[:80])

                step_text = ""
                step_reasoning = ""
                step_tool_calls: list[dict[str, Any]] = []

                if parent_emitter:
                    parent_emitter.emit_sse(
                        event="subagent_progress",
                        payload={
                            "agent_id": agent_id,
                            "agent_type": info.mode,
                            "mode": info.mode,
                            "task_prompt": info.task,
                            "step": step,
                            "max_steps": max_steps,
                            "status": "thinking",
                        },
                        channel=StreamChannel.CHAT,
                        agent_id=agent_id,
                        parent_call_id=parent_call_id,
                    )

                # LLM 流式调用
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
                        if controller and controller.preempt_event.is_set():
                            logger.info("子代理 [%s] 模型生成期间收到抢占信号", agent_id)
                            break

                        if chunk.type == "text" and chunk.text:
                            step_text += chunk.text
                            if parent_emitter:
                                parent_emitter.emit_sse(
                                    event="text_delta",
                                    payload={"text": chunk.text, "agent_id": agent_id},
                                    channel=StreamChannel.CHAT,
                                    agent_id=agent_id,
                                    parent_call_id=parent_call_id,
                                )
                        elif chunk.type == "reasoning" and chunk.text:
                            step_reasoning += chunk.text
                            if parent_emitter:
                                parent_emitter.emit_sse(
                                    event="reasoning_delta",
                                    payload={"text": chunk.text, "agent_id": agent_id},
                                    channel=StreamChannel.CHAT,
                                    agent_id=agent_id,
                                    parent_call_id=parent_call_id,
                                )
                        elif chunk.type == "tool_finish":
                            step_tool_calls.append(
                                {
                                    "id": chunk.tool_call_id,
                                    "name": chunk.tool_name,
                                    "arguments": chunk.arguments or {},
                                }
                            )
                except asyncio.CancelledError:
                    logger.info("子代理 [%s] 任务被取消中断", agent_id)
                    info.status = "TERMINATED"
                    raise
                except Exception as stream_err:
                    from services.agent_guard import extract_clean_error

                    err_code, err_msg = extract_clean_error(stream_err)
                    logger.error("子代理 [%s] 模型调用异常 (%s): %s", agent_id, err_code, err_msg)
                    info.error = err_msg
                    info.error_code = err_code
                    info.status = "FAILED"
                    if parent_emitter:
                        parent_emitter.emit_sse(
                            event="subagent_progress",
                            payload={
                                "agent_id": agent_id,
                                "agent_type": info.mode,
                                "mode": info.mode,
                                "task_prompt": info.task,
                                "step": step,
                                "status": "failed",
                                "error_code": err_code,
                                "error_message": err_msg,
                            },
                            channel=StreamChannel.CHAT,
                            agent_id=agent_id,
                            parent_call_id=parent_call_id,
                        )
                    break

                # 若在生成期间被抢占中断，立即消费纠偏并进入下一步
                if controller and controller.preempt_event.is_set():
                    steered_msgs = controller.drain_steering_messages()
                    steered_text = "\n\n".join(steered_msgs) if steered_msgs else "抢占转向"
                    sub_messages.append(
                        {
                            "role": "user",
                            "content": f"[Interrupted at step {step} by user input]\n{steered_text}",
                        }
                    )
                    controller.clear_preempt()
                    step += 1
                    continue

                info.latest_thinking = step_reasoning.strip() or step_text.strip()

                # 情况 A: 无工具调用，直接输出最终总结
                if not step_tool_calls:
                    final_summary = step_text.strip()
                    info.summary = final_summary
                    info.status = "COMPLETED"
                    info.latest_preview = final_summary[:200]

                    if parent_emitter:
                        parent_emitter.emit_sse(
                            event="subagent_progress",
                            payload={
                                "agent_id": agent_id,
                                "agent_type": info.mode,
                                "mode": info.mode,
                                "task_prompt": info.task,
                                "step": step,
                                "status": "completed",
                                "summary_preview": final_summary[:200],
                            },
                            channel=StreamChannel.CHAT,
                            agent_id=agent_id,
                            parent_call_id=parent_call_id,
                        )
                    break

                # 情况 B: 发起工具调用
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

                for tc in step_tool_calls:
                    tc_id = tc["id"]
                    tc_name = str(tc.get("name") or "")
                    tc_args = tc.get("arguments")
                    if isinstance(tc_args, str):
                        try:
                            tc_args = json.loads(tc_args)
                        except Exception:
                            tc_args = {}
                    elif not isinstance(tc_args, dict):
                        tc_args = {}

                    normalized_name = (
                        tc_name
                        if tc_name.startswith("workspace__")
                        else f"workspace__{tc_name}"
                    )

                    # 广播工具调用开始事件
                    if parent_emitter:
                        parent_emitter.emit_sse(
                            event=SSEEventName.TOOL_CALL_START.value,
                            payload={
                                "tool_call_id": tc_id,
                                "name": normalized_name,
                                "arguments": tc_args,
                                "agent_id": agent_id,
                            },
                            channel=StreamChannel.CHAT,
                            agent_id=agent_id,
                            parent_call_id=parent_call_id,
                        )

                    res_payload: Any = None
                    is_error = False

                    # 权限拦截
                    if normalized_name not in allowed_tool_names:
                        is_error = True
                        res_payload = {
                            "error": f"权限拒绝：Subagent [{info.mode}] 无权调用工具 '{tc_name}'"
                        }
                    else:
                        _, _, method = ToolAdapter.parse_namespaced_tool(normalized_name)

                        # 写操作作用域硬拦截 (write_file / edit_file / delete_file)
                        if method in ("write_file", "edit_file", "delete_file"):
                            target_path = tc_args.get("path", "")
                            allowed, deny_reason = self.lock_manager.is_write_allowed(
                                agent_id, target_path
                            )
                            if not allowed:
                                is_error = True
                                res_payload = {"error": deny_reason}
                                logger.warning("子代理 [%s] 发生越权写拦截: %s", agent_id, deny_reason)

                        if res_payload is None and not is_error:
                            try:
                                if workspace_root.startswith("bridge://"):
                                    from services.bridge_manager import BridgeManager
                                    bridge = BridgeManager.get_instance()
                                    bridge_uid = workspace_root[len("bridge://"):].split("::", 1)[0]
                                    if method == "read_file":
                                        res_payload = await bridge.call_rpc(
                                            bridge_uid, "fs.readFile", {"path": tc_args.get("path", "")}, timeout=15
                                        )
                                    elif method == "grep_search":
                                        res_payload = await bridge.call_rpc(
                                            bridge_uid,
                                            "fs.grepSearch",
                                            {
                                                "query": tc_args.get("query", ""),
                                                "path": tc_args.get("path", "."),
                                                "case_sensitive": tc_args.get("case_sensitive", False),
                                                "is_regex": tc_args.get("is_regex", False),
                                            },
                                            timeout=20,
                                        )
                                    elif method == "find_by_name":
                                        res_payload = await bridge.call_rpc(
                                            bridge_uid,
                                            "fs.findByName",
                                            {"pattern": tc_args.get("pattern", "*"), "path": tc_args.get("path", ".")},
                                            timeout=15,
                                        )
                                    elif method == "list_dir":
                                        res_payload = await bridge.call_rpc(
                                            bridge_uid,
                                            "fs.listDir",
                                            {"path": tc_args.get("path", "."), "recursive": tc_args.get("recursive", False)},
                                            timeout=15,
                                        )
                                    elif method == "execute_command" and info.mode in ("verify", "code_worker"):
                                        res_payload = await bridge.call_rpc(
                                            bridge_uid,
                                            "shell.execute",
                                            {"command": tc_args.get("command", ""), "timeout": tc_args.get("timeout", 30)},
                                            timeout=35,
                                        )
                                    elif method == "write_file" and info.mode == "code_worker":
                                        res_payload = await bridge.call_rpc(
                                            bridge_uid,
                                            "fs.writeFile",
                                            {"path": tc_args.get("path", ""), "content": tc_args.get("content", "")},
                                            timeout=15,
                                        )
                                        if isinstance(res_payload, dict) and res_payload.get("success"):
                                            info.modified_files.add(tc_args.get("path", ""))
                                    elif method == "edit_file" and info.mode == "code_worker":
                                        res_payload = await bridge.call_rpc(
                                            bridge_uid,
                                            "fs.editFile",
                                            {
                                                "path": tc_args.get("path", ""),
                                                "old_string": tc_args.get("old_string", ""),
                                                "new_string": tc_args.get("new_string", ""),
                                            },
                                            timeout=15,
                                        )
                                        if isinstance(res_payload, dict) and res_payload.get("success"):
                                            info.modified_files.add(tc_args.get("path", ""))
                                    elif method == "delete_file" and info.mode == "code_worker":
                                        res_payload = await bridge.call_rpc(
                                            bridge_uid, "fs.deleteFile", {"path": tc_args.get("path", "")}, timeout=15
                                        )
                                        if isinstance(res_payload, dict) and res_payload.get("success"):
                                            info.modified_files.add(tc_args.get("path", ""))
                                    else:
                                        is_error = True
                                        res_payload = {"error": f"子代理不支持的方法: {method}"}
                                elif method == "read_file":
                                    res_payload = await asyncio.to_thread(
                                        WorkspaceToolExecutor.read_file,
                                        workspace_root=workspace_root,
                                        path=tc_args.get("path", ""),
                                        offset=tc_args.get("offset", 1),
                                        limit=tc_args.get("limit", 200),
                                        with_line_numbers=tc_args.get("with_line_numbers", False),
                                    )
                                elif method == "grep_search":
                                    res_payload = await asyncio.to_thread(
                                        WorkspaceToolExecutor.grep_search,
                                        workspace_root=workspace_root,
                                        query=tc_args.get("query", ""),
                                        path=tc_args.get("path", "."),
                                        case_sensitive=tc_args.get("case_sensitive", False),
                                        is_regex=tc_args.get("is_regex", False),
                                    )
                                elif method == "find_by_name":
                                    res_payload = await asyncio.to_thread(
                                        WorkspaceToolExecutor.find_by_name,
                                        workspace_root=workspace_root,
                                        pattern=tc_args.get("pattern", "*"),
                                        path=tc_args.get("path", "."),
                                        type=tc_args.get("type", "any"),
                                    )
                                elif method == "list_dir":
                                    res_payload = await asyncio.to_thread(
                                        WorkspaceToolExecutor.list_dir,
                                        workspace_root=workspace_root,
                                        path=tc_args.get("path", "."),
                                        recursive=tc_args.get("recursive", False),
                                    )
                                elif method == "execute_command" and info.mode in ("verify", "code_worker"):
                                    res_payload = await WorkspaceToolExecutor.execute_command(
                                        workspace_root=workspace_root,
                                        command=tc_args.get("command", ""),
                                        timeout=tc_args.get("timeout", 30),
                                        is_background=False,
                                    )
                                elif method == "write_file" and info.mode == "code_worker":
                                    res_payload = await asyncio.to_thread(
                                        WorkspaceToolExecutor.write_file,
                                        workspace_root=workspace_root,
                                        path=tc_args.get("path", ""),
                                        content=tc_args.get("content", ""),
                                        overwrite=tc_args.get("overwrite", True),
                                    )
                                    if isinstance(res_payload, dict) and res_payload.get("success"):
                                        info.modified_files.add(tc_args.get("path", ""))
                                elif method == "edit_file" and info.mode == "code_worker":
                                    res_payload = await asyncio.to_thread(
                                        WorkspaceToolExecutor.edit_file,
                                        workspace_root=workspace_root,
                                        path=tc_args.get("path", ""),
                                        old_string=tc_args.get("old_string", ""),
                                        new_string=tc_args.get("new_string", ""),
                                    )
                                    if isinstance(res_payload, dict) and res_payload.get("success"):
                                        info.modified_files.add(tc_args.get("path", ""))
                                elif method == "delete_file" and info.mode == "code_worker":
                                    res_payload = await asyncio.to_thread(
                                        WorkspaceToolExecutor.delete_file,
                                        workspace_root=workspace_root,
                                        path=tc_args.get("path", ""),
                                    )
                                    if isinstance(res_payload, dict) and res_payload.get("success"):
                                        info.modified_files.add(tc_args.get("path", ""))
                                else:
                                    is_error = True
                                    res_payload = {"error": f"子代理模式 [{info.mode}] 不支持工具: {method}"}
                            except Exception as exec_err:
                                is_error = True
                                res_payload = {"error": str(exec_err)}

                    tool_str = json.dumps(res_payload, ensure_ascii=False)
                    sub_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc_id,
                            "content": tool_str,
                            "is_error": is_error,
                        }
                    )

                    # 广播工具执行结果事件
                    if parent_emitter:
                        parent_emitter.emit_sse(
                            event=SSEEventName.TOOL_CALL_RESULT.value,
                            payload={
                                "tool_call_id": tc_id,
                                "name": normalized_name,
                                "result": res_payload,
                                "is_error": is_error,
                                "agent_id": agent_id,
                            },
                            channel=StreamChannel.CHAT,
                            agent_id=agent_id,
                            parent_call_id=parent_call_id,
                        )

                step += 1

            # 若步数耗尽仍未产出总结，且未失败/未中止，触发单轮收尾提炼
            if not final_summary and info.status not in ("TERMINATED", "FAILED"):
                sub_messages.append(
                    {
                        "role": "user",
                        "content": "已达到最大步数上限。请基于前序调查查验的所有信息，直接输出最终结构清晰的完整报告。",
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
                        if chunk.type == "text" and chunk.text:
                            final_summary += chunk.text
                    info.summary = final_summary.strip()
                    info.status = "COMPLETED"
                    if parent_emitter:
                        parent_emitter.emit_sse(
                            event="subagent_progress",
                            payload={
                                "agent_id": agent_id,
                                "agent_type": info.mode,
                                "mode": info.mode,
                                "task_prompt": info.task,
                                "step": step,
                                "status": "completed",
                                "summary_preview": info.summary[:200],
                            },
                            channel=StreamChannel.CHAT,
                            agent_id=agent_id,
                            parent_call_id=parent_call_id,
                        )
                except Exception as e:
                    from services.agent_guard import extract_clean_error

                    err_code, err_msg = extract_clean_error(e)
                    logger.warning("子代理 [%s] 强制总结失败 (%s): %s", agent_id, err_code, err_msg)
                    info.summary = ""
                    info.error = err_msg
                    info.error_code = err_code
                    info.status = "FAILED"
                    if parent_emitter:
                        parent_emitter.emit_sse(
                            event="subagent_progress",
                            payload={
                                "agent_id": agent_id,
                                "agent_type": info.mode,
                                "mode": info.mode,
                                "task_prompt": info.task,
                                "step": step,
                                "status": "failed",
                                "error_code": err_code,
                                "error_message": err_msg,
                            },
                            channel=StreamChannel.CHAT,
                            agent_id=agent_id,
                            parent_call_id=parent_call_id,
                        )

        except asyncio.CancelledError:
            info.status = "TERMINATED"
            raise
        except Exception as err:
            from services.agent_guard import extract_clean_error

            err_code, err_msg = extract_clean_error(err)
            logger.error("子代理 [%s] 异常崩溃 (%s): %s", agent_id, err_code, err_msg)
            info.status = "FAILED"
            info.error = err_msg
            info.error_code = err_code
            if parent_emitter:
                parent_emitter.emit_sse(
                    event="subagent_progress",
                    payload={
                        "agent_id": agent_id,
                        "agent_type": info.mode,
                        "mode": info.mode,
                        "task_prompt": info.task,
                        "step": step,
                        "status": "failed",
                        "error_code": err_code,
                        "error_message": err_msg,
                    },
                    channel=StreamChannel.CHAT,
                    agent_id=agent_id,
                    parent_call_id=parent_call_id,
                )
        finally:
            info.end_time = time.time()
            if info.status == "RUNNING":
                info.status = "COMPLETED" if not info.error else "FAILED"

            # 无论何种退出路径，绝对释放当前代理全部锁
            self.lock_manager.release(agent_id)

            # 从父控制器中解绑
            if parent_controller is not None and info.task_handle is not None:
                parent_controller.active_subtasks.discard(info.task_handle)

            logger.info(
                "子代理 [%s] 协程结束，最终状态: %s (耗时: %.2fs)",
                agent_id,
                info.status,
                info.end_time - info.start_time,
            )

    async def wait_agent(
        self,
        agent_ids: list[str],
        timeout_ms: int = 30000,
        return_when: Literal["FIRST_COMPLETED", "ALL_COMPLETED"] = "ALL_COMPLETED",
    ) -> dict[str, Any]:
        """基于 asyncio 等待目标子代理完成，返回结构化汇报与进行中快照"""
        if not agent_ids:
            return {"completed": {}, "running": {}, "all_completed": True}

        target_ids = list(agent_ids)
        running_tasks: list[asyncio.Task[Any]] = []
        for aid in target_ids:
            info = self.agents.get(aid)
            if info and info.status == "RUNNING" and info.task_handle and not info.task_handle.done():
                running_tasks.append(info.task_handle)

        if running_tasks:
            timeout_sec = max(0.001, timeout_ms / 1000.0)
            wait_cond = (
                asyncio.FIRST_COMPLETED
                if return_when == "FIRST_COMPLETED"
                else asyncio.ALL_COMPLETED
            )
            try:
                await asyncio.wait(
                    running_tasks,
                    timeout=timeout_sec,
                    return_when=wait_cond,
                )
            except Exception as wait_err:
                logger.warning("wait_agent 等待异常: %s", wait_err)

        completed_dict: dict[str, Any] = {}
        running_dict: dict[str, Any] = {}

        for aid in target_ids:
            info = self.agents.get(aid)
            if not info:
                completed_dict[aid] = {
                    "status": "NOT_FOUND",
                    "success": False,
                    "error": f"未找到子代理 [{aid}]",
                }
                continue

            is_done = info.status in ("COMPLETED", "FAILED", "TERMINATED") or (
                info.task_handle is not None and info.task_handle.done()
            )

            if is_done:
                duration = (info.end_time or time.time()) - info.start_time
                completed_dict[aid] = {
                    "status": info.status,
                    "mode": info.mode,
                    "summary": info.summary,
                    "modified_files": sorted(list(info.modified_files)),
                    "duration_ms": int(duration * 1000),
                    "steps_taken": info.steps_taken,
                    "success": info.status == "COMPLETED",
                    "error": info.error,
                    "error_code": info.error_code,
                }
            else:
                elapsed = time.time() - info.start_time
                running_dict[aid] = {
                    "status": "RUNNING",
                    "mode": info.mode,
                    "step": info.steps_taken,
                    "latest_thinking": info.latest_thinking,
                    "latest_preview": info.latest_preview,
                    "elapsed_ms": int(elapsed * 1000),
                }

        return {
            "success": True,
            "completed": completed_dict,
            "running": running_dict,
            "all_completed": len(running_dict) == 0,
        }

    async def send_input(
        self,
        agent_id: str,
        message: str,
        interrupt: bool = True,
    ) -> dict[str, Any]:
        """向运行中的子代理注入纠偏指令，若 interrupt=True 立即触发抢占"""
        info = self.agents.get(agent_id)
        if not info:
            return {
                "success": False,
                "agent_id": agent_id,
                "error": f"未找到子代理 [{agent_id}]",
            }
        if info.status != "RUNNING":
            return {
                "success": False,
                "agent_id": agent_id,
                "error": f"子代理 [{agent_id}] 处于非运行状态 ({info.status})，无法注入指令",
            }

        cleaned = str(message or "").strip()
        if not cleaned:
            return {
                "success": False,
                "agent_id": agent_id,
                "error": "纠偏指令内容不能为空",
            }

        if info.controller is not None:
            info.controller.trigger_steer(cleaned, preempt=interrupt)
            logger.info("已向子代理 [%s] 投递纠偏指令 (interrupt=%s): %s", agent_id, interrupt, cleaned[:60])
            return {
                "success": True,
                "agent_id": agent_id,
                "interrupted": interrupt,
                "message": "纠偏指令已成功注入子代理",
            }

        return {
            "success": False,
            "agent_id": agent_id,
            "error": f"子代理 [{agent_id}] 控制器不可用",
        }

    async def close_agent(self, agent_id: str) -> dict[str, Any]:
        """单点强制终止子代理并即时释放其全部锁"""
        info = self.agents.get(agent_id)
        if not info:
            return {
                "success": False,
                "agent_id": agent_id,
                "error": f"未找到子代理 [{agent_id}]",
            }

        if info.status == "RUNNING":
            if info.controller is not None:
                info.controller.trigger_abort()
            if info.task_handle is not None and not info.task_handle.done():
                info.task_handle.cancel()
            info.status = "TERMINATED"
            info.end_time = time.time()

        # 立即释放其持有的全部读写锁
        self.lock_manager.release(agent_id)
        logger.info("子代理 [%s] 已被单点终止并释放锁", agent_id)

        return {
            "success": True,
            "agent_id": agent_id,
            "status": "TERMINATED",
            "message": f"子代理 [{agent_id}] 已成功终止并释放全部锁",
        }

    def stop_session_agents(self, session_id: str) -> None:
        """连带终止属于指定会话的所有运行中子代理"""
        for aid, info in list(self.agents.items()):
            if info.session_id == session_id and info.status == "RUNNING":
                if info.controller is not None:
                    info.controller.trigger_abort()
                if info.task_handle is not None and not info.task_handle.done():
                    info.task_handle.cancel()
                info.status = "TERMINATED"
                info.end_time = time.time()
                self.lock_manager.release(aid)
                logger.info("会话 [%s] 关联子代理 [%s] 已连带终止", session_id, aid)

    def cleanup_all(self) -> None:
        """终止全量存活子代理并清空锁"""
        for aid, info in list(self.agents.items()):
            if info.status == "RUNNING":
                if info.controller is not None:
                    info.controller.trigger_abort()
                if info.task_handle is not None and not info.task_handle.done():
                    info.task_handle.cancel()
                info.status = "TERMINATED"
                info.end_time = time.time()
                self.lock_manager.release(aid)
        self.lock_manager.clear_all()


# 全局多代理网格单例
multi_agent_mesh = MultiAgentMesh(lock_manager=workspace_lock_manager)


# ============================================================================
# 6. 注册工作区工具到 ToolRegistry
# ============================================================================


@tool_registry.register(
    name="workspace__spawn_agent",
    mutating=False,
    requires_approval=False,
    timeout_sec=30.0,
    supports_bridge=False,
)
async def _handle_spawn_agent(
    workspace_root: str,
    tc_args: dict[str, Any],
    user_id: Optional[str] = None,
    session_id: Optional[str] = None,
    controller: Optional[PreemptiveController] = None,
    emitter: Optional[EnvelopeEmitter] = None,
    **kwargs: Any,
) -> dict[str, Any]:
    task = str(tc_args.get("task", ""))
    mode = str(tc_args.get("mode", "explore"))
    fork_context = bool(tc_args.get("fork_context", False))
    write_scope = tc_args.get("write_scope")
    parent_call_id = str(kwargs.get("tool_call_id") or tc_args.get("tool_call_id") or "")

    return await multi_agent_mesh.spawn_agent(
        task=task,
        mode=mode,  # type: ignore[arg-type]
        fork_context=fork_context,
        write_scope=write_scope,
        workspace_root=workspace_root,
        session_id=str(session_id or "default"),
        parent_controller=controller,
        parent_emitter=emitter or kwargs.get("emitter"),
        parent_call_id=parent_call_id or None,
        model=str(kwargs.get("model") or "gpt-4o"),
        api_key=kwargs.get("api_key"),
        base_url=kwargs.get("base_url"),
        provider=kwargs.get("provider"),
        parent_messages=kwargs.get("parent_messages"),
        user_id=user_id,
    )


@tool_registry.register(
    name="workspace__wait_agent",
    mutating=False,
    requires_approval=False,
    timeout_sec=120.0,
    supports_bridge=False,
)
async def _handle_wait_agent(
    workspace_root: str,
    tc_args: dict[str, Any],
    **kwargs: Any,
) -> dict[str, Any]:
    raw_ids = tc_args.get("agent_ids") or []
    if isinstance(raw_ids, str):
        raw_ids = [raw_ids]
    timeout_ms = int(tc_args.get("timeout_ms", 30000))
    return_when = str(tc_args.get("return_when", "ALL_COMPLETED"))

    return await multi_agent_mesh.wait_agent(
        agent_ids=list(raw_ids),
        timeout_ms=timeout_ms,
        return_when=return_when,  # type: ignore[arg-type]
    )


@tool_registry.register(
    name="workspace__send_input",
    mutating=False,
    requires_approval=False,
    timeout_sec=15.0,
    supports_bridge=False,
)
async def _handle_send_input(
    workspace_root: str,
    tc_args: dict[str, Any],
    **kwargs: Any,
) -> dict[str, Any]:
    agent_id = str(tc_args.get("agent_id", ""))
    message = str(tc_args.get("message", ""))
    interrupt = bool(tc_args.get("interrupt", True))

    return await multi_agent_mesh.send_input(
        agent_id=agent_id,
        message=message,
        interrupt=interrupt,
    )


@tool_registry.register(
    name="workspace__close_agent",
    mutating=False,
    requires_approval=False,
    timeout_sec=15.0,
    supports_bridge=False,
)
async def _handle_close_agent(
    workspace_root: str,
    tc_args: dict[str, Any],
    **kwargs: Any,
) -> dict[str, Any]:
    agent_id = str(tc_args.get("agent_id", ""))
    return await multi_agent_mesh.close_agent(agent_id=agent_id)
