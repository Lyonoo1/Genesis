import asyncio
import inspect
import logging
import os
import re
import time
import uuid
from typing import Any, Callable, Optional

from models.schemas.stream_envelope import EnvelopeEmitter, StreamChannel
from services.agent_state_machine import tool_registry
from services.terminal_manager import TerminalManager, TerminalSession, kill_process_group

logger = logging.getLogger("genesis.pty_bridge")

ANSI_ESCAPE_REGEX = re.compile(
    r"(?:\x1B[@-Z\\-_]|[\x80-\x9A\x9C-\x9F]|(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~])"
)

PORT_REGEX = re.compile(
    r"(?:http://(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(?P<p1>\d{4,5}))"
    r"|(?:(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(?P<p2>\d{4,5}))"
    r"|(?:port\s*(?P<p3>\d{4,5}))"
    r"|(?P<p4>https?://[^\s\"']+)",
    re.IGNORECASE,
)


def strip_ansi(text: str) -> str:
    """剥离 ANSI 彩色与光标控制符，规格化换行符"""
    if not text:
        return ""
    clean = ANSI_ESCAPE_REGEX.sub("", text)
    return clean.replace("\r\n", "\n").replace("\r", "")


def detect_url(text: str) -> Optional[str]:
    """探测控制台文本中输出的 Web 访问地址或端口"""
    if not text:
        return None
    m = PORT_REGEX.search(text)
    if m:
        if m.groupdict().get("p4"):
            return m.group("p4").replace("://0.0.0.0", "://localhost")
        port = (
            m.groupdict().get("p1")
            or m.groupdict().get("p2")
            or m.groupdict().get("p3")
        )
        if port:
            return f"http://localhost:{port}"
    return None


def _extract_command_output(
    accumulated_text: str,
    cmd_id: Optional[str] = None,
    cmd_str: Optional[str] = None,
) -> tuple[str, str]:
    """提取干净输出并剥离前置回显与 Sentinel 结束标记"""
    raw = accumulated_text
    if cmd_id:
        sentinel_pattern = re.compile(
            r"__GENESIS_CMD_DONE_" + re.escape(cmd_id) + r":(-?\d+)__"
        )
        m = sentinel_pattern.search(raw)
        if m:
            raw = raw[: m.start()]

    # 剥离首行命令输入回显
    first_nl = raw.find("\n")
    if first_nl != -1:
        first_line = raw[:first_nl]
        first_token = cmd_str.strip().split()[0] if cmd_str and cmd_str.strip() else ""
        if first_token and (first_token in first_line or "__GENESIS_CMD_DONE_" in first_line):
            raw = raw[first_nl + 1 :]

    clean = strip_ansi(raw)
    lines = clean.splitlines()

    # 剥离尾部空白和 Shell 提示符
    while lines and (not lines[-1].strip() or lines[-1].strip() in ("%", "$", "#", ">")):
        lines.pop()

    clean_stdout = "\n".join(lines).strip()
    return clean_stdout, raw


async def _exec_command_async(
    workspace_root: str,
    cmd: str,
    session_id: Optional[str] = None,
    yield_time_ms: int = 5000,
    is_background: bool = False,
    emitter: Optional[EnvelopeEmitter] = None,
) -> dict[str, Any]:
    """在持久化 PTY 终端会话中异步执行命令，带智能挂起检测与实时增量流广播"""
    pty_sid = (
        session_id
        if (session_id and str(session_id).startswith("pty_"))
        else f"pty_{session_id or 'default'}"
    )

    tm = TerminalManager.get_instance()
    session = tm.get_or_create_session(session_id=pty_sid, cwd=workspace_root)
    session.ensure_event_loop()

    queue = session.subscribe()
    cmd_id = uuid.uuid4().hex[:8]
    sentinel_pattern = re.compile(
        r"__GENESIS_CMD_DONE_" + re.escape(cmd_id) + r":(-?\d+)__"
    )

    clean_cmd = cmd.strip()
    if "\n" in clean_cmd:
        cmd_to_write = f"(\n{clean_cmd}\n) ; echo \"__GENESIS_CMD_DONE_{cmd_id}:$?__\"\n"
    else:
        cmd_to_write = f"{clean_cmd} ; echo \"__GENESIS_CMD_DONE_{cmd_id}:$?__\"\n"

    session.write(cmd_to_write)

    collected_chunks: list[str] = []
    exit_code: Optional[int] = None
    completed = False
    start_time = time.time()
    effective_yield_ms = max(100, int(yield_time_ms))
    deadline = start_time + (effective_yield_ms / 1000.0)

    try:
        while time.time() < deadline:
            remaining = max(0.01, deadline - time.time())
            wait_timeout = min(0.1, remaining)
            try:
                msg = await asyncio.wait_for(queue.get(), timeout=wait_timeout)
                m_type = msg.get("type")
                if m_type == "output":
                    chunk = msg.get("data", "")
                    collected_chunks.append(chunk)

                    # 实时广播给 SSE 客户端与右侧栏终端
                    if emitter is not None:
                        try:
                            emitter.emit_sse(
                                event="terminal_output",
                                payload={"session_id": pty_sid, "output": chunk},
                                channel=StreamChannel.WORKBENCH_PTY,
                            )
                        except Exception as emit_err:
                            logger.debug("Failed emitting pty SSE chunk: %s", emit_err)

                    # 检查 Sentinel 标记
                    all_text = "".join(collected_chunks)
                    m = sentinel_pattern.search(all_text)
                    if m:
                        exit_code = int(m.group(1))
                        completed = True
                        break

                elif m_type == "exit":
                    completed = True
                    exit_code = int(msg.get("code", 0))
                    break

            except asyncio.TimeoutError:
                pass
    finally:
        session.unsubscribe(queue)

    all_raw = "".join(collected_chunks)

    if completed:
        clean_out, raw_out = _extract_command_output(all_raw, cmd_id, clean_cmd)
        url = detect_url(clean_out)
        return {
            "success": (exit_code == 0),
            "status": "COMPLETED",
            "exit_code": exit_code,
            "returncode": exit_code,  # 兼容传统测试断言
            "session_id": pty_sid,
            "stdout": clean_out,
            "raw_output": raw_out,
            "detected_url": url,
            "command": cmd,
        }
    else:
        clean_out, raw_out = _extract_command_output(all_raw, None, clean_cmd)
        url = detect_url(clean_out)
        hint = (
            "命令仍在交互式 PTY 中运行。若需输入交互响应请调用 workspace__write_stdin，"
            "若为后台开发服务器可直接继续后续步骤。"
        )
        return {
            "success": True,
            "status": "RUNNING_INTERACTIVE",
            "session_id": pty_sid,
            "stdout": clean_out,
            "raw_output": raw_out,
            "detected_url": url,
            "hint": hint,
            "command": cmd,
        }


async def _write_stdin_async(
    session_id: str,
    input_chars: str,
    yield_time_ms: int = 2000,
    emitter: Optional[EnvelopeEmitter] = None,
) -> dict[str, Any]:
    """向指定 PTY 终端注入按键流并收集后续输出回显"""
    sid = str(session_id)
    tm = TerminalManager.get_instance()
    session = tm.get_session(sid) or tm.get_session(f"pty_{sid}")
    if not session or not session.is_alive():
        return {
            "success": False,
            "error": f"终端会话不存在或已退出: {sid}",
            "session_id": sid,
        }

    session.ensure_event_loop()
    queue = session.subscribe()

    session.write(input_chars)

    collected_chunks: list[str] = []
    exit_code: Optional[int] = None
    completed = False
    start_time = time.time()
    effective_yield_ms = max(50, int(yield_time_ms))
    deadline = start_time + (effective_yield_ms / 1000.0)

    # 匹配可能存在的任何 Sentinel (格式: __GENESIS_CMD_DONE_[a-f0-9]+:(-?\d+)__)
    generic_sentinel = re.compile(r"__GENESIS_CMD_DONE_[a-zA-Z0-9]+:(-?\d+)__")

    try:
        while time.time() < deadline:
            remaining = max(0.01, deadline - time.time())
            wait_timeout = min(0.1, remaining)
            try:
                msg = await asyncio.wait_for(queue.get(), timeout=wait_timeout)
                m_type = msg.get("type")
                if m_type == "output":
                    chunk = msg.get("data", "")
                    collected_chunks.append(chunk)

                    if emitter is not None:
                        try:
                            emitter.emit_sse(
                                event="terminal_output",
                                payload={"session_id": session.id, "output": chunk},
                                channel=StreamChannel.WORKBENCH_PTY,
                            )
                        except Exception:
                            pass

                    m = generic_sentinel.search("".join(collected_chunks))
                    if m:
                        exit_code = int(m.group(1))
                        completed = True
                        break

                elif m_type == "exit":
                    completed = True
                    exit_code = int(msg.get("code", 0))
                    break

            except asyncio.TimeoutError:
                pass
    finally:
        session.unsubscribe(queue)

    all_raw = "".join(collected_chunks)
    clean_out = strip_ansi(all_raw).strip()
    url = detect_url(clean_out)

    status = "COMPLETED" if completed else "RUNNING_INTERACTIVE"
    return {
        "success": True,
        "status": status,
        "exit_code": exit_code,
        "session_id": session.id,
        "stdout": clean_out,
        "raw_output": all_raw,
        "detected_url": url,
    }


def exec_command(
    workspace_root: str,
    cmd: str,
    session_id: Optional[str] = None,
    yield_time_ms: int = 5000,
    is_background: bool = False,
    emitter: Optional[EnvelopeEmitter] = None,
) -> Any:
    """执行交互式 PTY 命令原语（双模兼容同步与异步执行上下文）"""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        return _exec_command_async(
            workspace_root=workspace_root,
            cmd=cmd,
            session_id=session_id,
            yield_time_ms=yield_time_ms,
            is_background=is_background,
            emitter=emitter,
        )
    else:
        return asyncio.run(
            _exec_command_async(
                workspace_root=workspace_root,
                cmd=cmd,
                session_id=session_id,
                yield_time_ms=yield_time_ms,
                is_background=is_background,
                emitter=emitter,
            )
        )


def write_stdin(
    session_id: str,
    input_chars: str,
    yield_time_ms: int = 2000,
    emitter: Optional[EnvelopeEmitter] = None,
) -> Any:
    """向交互式 PTY 注入按键原语（双模兼容同步与异步执行上下文）"""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        return _write_stdin_async(
            session_id=session_id,
            input_chars=input_chars,
            yield_time_ms=yield_time_ms,
            emitter=emitter,
        )
    else:
        return asyncio.run(
            _write_stdin_async(
                session_id=session_id,
                input_chars=input_chars,
                yield_time_ms=yield_time_ms,
                emitter=emitter,
            )
        )


# ============================================================================
# ToolRegistry 声明式注册
# ============================================================================
@tool_registry.register(
    name="workspace__exec_command",
    mutating=True,
    requires_approval=False,
    timeout_sec=60.0,
    supports_bridge=True,
)
async def _handle_pty_exec_command(
    workspace_root: str,
    tc_args: dict[str, Any],
    session_id: Optional[str] = None,
    **kwargs: Any,
) -> dict[str, Any]:
    cmd = tc_args.get("cmd") or tc_args.get("command") or ""
    yield_time_ms = int(tc_args.get("yield_time_ms", 5000))
    is_background = bool(tc_args.get("is_background", False))
    emitter = kwargs.get("emitter")
    res = exec_command(
        workspace_root=workspace_root,
        cmd=cmd,
        session_id=session_id,
        yield_time_ms=yield_time_ms,
        is_background=is_background,
        emitter=emitter,
    )
    if inspect.isawaitable(res):
        return await res
    return res


@tool_registry.register(
    name="workspace__write_stdin",
    mutating=True,
    requires_approval=False,
    timeout_sec=30.0,
    supports_bridge=True,
)
async def _handle_pty_write_stdin(
    workspace_root: str,
    tc_args: dict[str, Any],
    session_id: Optional[str] = None,
    **kwargs: Any,
) -> dict[str, Any]:
    sid = tc_args.get("session_id") or session_id or "default"
    input_chars = tc_args.get("input_chars") or tc_args.get("input") or ""
    yield_time_ms = int(tc_args.get("yield_time_ms", 2000))
    emitter = kwargs.get("emitter")
    res = write_stdin(
        session_id=sid,
        input_chars=input_chars,
        yield_time_ms=yield_time_ms,
        emitter=emitter,
    )
    if inspect.isawaitable(res):
        return await res
    return res
