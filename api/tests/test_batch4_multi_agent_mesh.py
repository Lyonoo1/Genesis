import asyncio
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from core.security import AuthenticatedUser, get_current_user
from core.sqlite_db import init_sqlite_db
from main import app
from models.schemas.stream_envelope import (
    EnvelopeEmitter,
    StreamChannel,
    StreamEnvelope,
)
from services.agent_state_machine import PreemptiveController
from services.multi_agent_mesh import (
    LockConflictError,
    MultiAgentMesh,
    ScopeViolationError,
    SubagentInfo,
    WorkspaceLockManager,
    multi_agent_mesh,
    workspace_lock_manager,
)


def dummy_auth_user():
    return AuthenticatedUser(
        user_id="00000000-0000-0000-0000-000000000001",
        email="developer@genesis.local",
    )


@pytest.fixture(autouse=True)
def setup_test_env():
    init_sqlite_db()
    multi_agent_mesh.cleanup_all()
    workspace_lock_manager.clear_all()
    yield
    multi_agent_mesh.cleanup_all()
    workspace_lock_manager.clear_all()


@pytest.fixture
def client():
    app.dependency_overrides[get_current_user] = dummy_auth_user
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def temp_ws(tmp_path):
    ws = tmp_path / "ws_batch4"
    ws.mkdir(parents=True, exist_ok=True)
    return str(ws)


# ==============================================================================
# 1. 主 Agent 并发 spawn_agent 非阻塞立即返回与 wait_agent 汇总结果测试
# ==============================================================================
@pytest.mark.anyio
async def test_spawn_agent_non_blocking_and_wait(temp_ws):
    """测试 spawn_agent 立即非阻塞返回 RUNNING 状态，并在同一轮并发派发多个子代理并通过 wait_agent 聚合结果"""
    mesh = MultiAgentMesh()

    # 模拟后台执行循环快速完成
    async def fast_worker(info: SubagentInfo, **kwargs):
        await asyncio.sleep(0.05)
        info.status = "COMPLETED"
        info.summary = f"Completed task: {info.task}"
        info.modified_files = ["src/test.py"]
        info.end_time = time.time()
        mesh.lock_manager.release(info.agent_id)

    with patch.object(mesh, "_subagent_worker_loop", side_effect=fast_worker):
        # 1. 连续非阻塞派发两个并行子代理
        res1 = await mesh.spawn_agent(
            task="调研认证模块设计",
            mode="explore",
            workspace_root=temp_ws,
            session_id="sess_123",
            parent_call_id="call_spawn_1",
        )
        res2 = await mesh.spawn_agent(
            task="运行单元测试",
            mode="verify",
            workspace_root=temp_ws,
            session_id="sess_123",
            parent_call_id="call_spawn_2",
        )

        # 验证立即非阻塞返回
        assert res1["success"] is True
        assert res1["status"] == "RUNNING"
        assert res1["agent_id"].startswith("subagent_")
        assert res1["parent_call_id"] == "call_spawn_1"

        assert res2["success"] is True
        assert res2["status"] == "RUNNING"
        assert res2["agent_id"].startswith("subagent_")
        assert res2["parent_call_id"] == "call_spawn_2"
        assert res1["agent_id"] != res2["agent_id"]

        agent_ids = [res1["agent_id"], res2["agent_id"]]

        # 2. 调用 wait_agent 聚合等待结果
        wait_res = await mesh.wait_agent(
            agent_ids=agent_ids,
            timeout_ms=5000,
            return_when="ALL_COMPLETED",
        )

        assert wait_res["success"] is True
        assert wait_res["all_completed"] is True
        assert len(wait_res["completed"]) == 2

        reports = wait_res["completed"]
        assert res1["agent_id"] in reports
        assert res2["agent_id"] in reports
        assert "调研认证模块设计" in reports[res1["agent_id"]]["summary"]
        assert "运行单元测试" in reports[res2["agent_id"]]["summary"]


# ==============================================================================
# 2. WorkspaceLockManager 读写分离、互斥锁冲突拦截与越权拦截测试
# ==============================================================================
@pytest.mark.anyio
async def test_workspace_lock_manager_mutex_and_scope_violation(temp_ws):
    """测试 WorkspaceLockManager 对重叠 write_scope 的互斥拦截及写越权防护"""
    lock_mgr = WorkspaceLockManager()

    # 1. 共享读锁测试：explore 和 verify 可同时持有读锁
    read_ok1 = await lock_mgr.acquire_read("agent_read_1", ["*"])
    read_ok2 = await lock_mgr.acquire_read("agent_read_2", ["src/**"])
    assert read_ok1 is True
    assert read_ok2 is True

    # 2. 排他写锁测试：agent_code_1 独占锁定 src/auth/**
    scope_1 = ["src/auth/**", "tests/test_auth.py"]
    write_ok1 = await lock_mgr.acquire_write("agent_code_1", scope_1)
    assert write_ok1 is True

    # 3. 冲突拦截：agent_code_2 尝试申请重叠范围 src/auth/login.py，必须抛出 LockConflictError
    scope_2 = ["src/auth/login.py"]
    with pytest.raises(LockConflictError) as exc_info:
        await lock_mgr.acquire_write("agent_code_2", scope_2, timeout=0)
    assert exc_info.value.conflicting_agent_id == "agent_code_1"

    # 4. 越权校验：agent_code_1 写作用域内文件合法，写作用域外文件必须拦截
    # 合法路径
    lock_mgr.validate_write("agent_code_1", "src/auth/jwt.py")
    lock_mgr.validate_write("agent_code_1", "tests/test_auth.py")

    # 越权路径
    with pytest.raises(ScopeViolationError) as scope_err:
        lock_mgr.validate_write("agent_code_1", "src/database/models.py")
    assert scope_err.value.agent_id == "agent_code_1"
    assert "src/database/models.py" in str(scope_err.value)

    # 5. 锁释放与再次申请
    lock_mgr.release("agent_code_1")
    # 释放后 agent_code_2 即可成功获取写锁
    write_ok2 = await lock_mgr.acquire_write("agent_code_2", scope_2, timeout=0)
    assert write_ok2 is True
    lock_mgr.release("agent_code_2")


@pytest.mark.anyio
async def test_mesh_spawn_lock_conflict_response(temp_ws):
    """测试通过 spawn_agent 派发重叠 write_scope 时直接返回 CONFLICT 状态"""
    mesh = MultiAgentMesh(lock_manager=WorkspaceLockManager())

    # 派发第一个 code_worker
    res1 = await mesh.spawn_agent(
        task="修改鉴权逻辑",
        mode="code_worker",
        write_scope=["src/auth/**"],
        workspace_root=temp_ws,
    )
    assert res1["success"] is True
    aid1 = res1["agent_id"]

    # 派发第二个 code_worker，作用域重叠
    res2 = await mesh.spawn_agent(
        task="修改登录逻辑",
        mode="code_worker",
        write_scope=["src/auth/oauth.py"],
        workspace_root=temp_ws,
    )
    assert res2["success"] is False
    assert res2["status"] == "CONFLICT"
    assert res2["conflicting_agent_id"] == aid1
    assert "src/auth/**" in res2["conflict_scope"] or "src/auth/oauth.py" in res2["conflict_scope"]

    await mesh.close_agent(aid1)


# ==============================================================================
# 3. 运行中 send_input 纠偏与抢占中断测试
# ==============================================================================
@pytest.mark.anyio
async def test_send_input_steer_and_interrupt(temp_ws):
    """测试通过 send_input 向运行中子代理注入纠偏指令，触发 PreemptiveController 转向"""
    mesh = MultiAgentMesh()

    started_event = asyncio.Event()

    async def long_running_worker(info: SubagentInfo, **kwargs):
        started_event.set()
        # 持续循环监听 steer
        while info.status == "RUNNING":
            if info.controller and info.controller.has_steer():
                steer_msg = info.controller.consume_steer()
                info.summary = f"Steered with: {steer_msg}"
                info.status = "COMPLETED"
                break
            await asyncio.sleep(0.02)
        mesh.lock_manager.release(info.agent_id)

    with patch.object(mesh, "_subagent_worker_loop", side_effect=long_running_worker):
        res = await mesh.spawn_agent(
            task="初始任务",
            mode="explore",
            workspace_root=temp_ws,
        )
        aid = res["agent_id"]

        # 等待子代理启动
        await asyncio.wait_for(started_event.wait(), timeout=2.0)

        # 注入纠偏指令
        steer_res = await mesh.send_input(
            agent_id=aid,
            message="优先检查 src/token.py",
            interrupt=True,
        )
        assert steer_res["success"] is True
        assert steer_res["interrupted"] is True

        # 等待子代理响应纠偏完成
        wait_res = await mesh.wait_agent([aid], timeout_ms=3000)
        assert wait_res["success"] is True
        assert len(wait_res["completed"]) == 1
        assert "优先检查 src/token.py" in wait_res["completed"][aid]["summary"]


# ==============================================================================
# 4. 子代理流事件携带 agent_id 与 parent_call_id 汇入主 SSE 信封测试
# ==============================================================================
@pytest.mark.anyio
async def test_multiplexed_subagent_sse_envelope():
    """测试子代理多路复用流事件携带正确的 agent_id 与 parent_call_id 进入主会话 EnvelopeEmitter"""
    emitter = EnvelopeEmitter(turn_id="turn_parent_42")

    env1 = emitter.create_envelope(
        event="subagent_progress",
        payload={"step": 1, "text": "正在读取 schema.sql"},
        channel=StreamChannel.CHAT,
        agent_id="subagent_test_99",
        parent_call_id="call_parent_xyz",
    )

    env2 = emitter.create_envelope(
        event="text_delta",
        payload={"delta": "已发现 3 处主键索引"},
        channel=StreamChannel.CHAT,
        agent_id="subagent_test_99",
        parent_call_id="call_parent_xyz",
    )

    # 检查信封字段规范
    assert env1.agent_id == "subagent_test_99"
    assert env1.parent_call_id == "call_parent_xyz"
    assert env1.event == "subagent_progress"
    assert env1.payload["step"] == 1
    assert env1.turn_id == "turn_parent_42"

    assert env2.agent_id == "subagent_test_99"
    assert env2.parent_call_id == "call_parent_xyz"
    assert env2.event == "text_delta"
    assert env2.payload["delta"] == "已发现 3 处主键索引"
    assert env2.seq == env1.seq + 1


# ==============================================================================
# 5. REST API: steer & stop 控制路由测试
# ==============================================================================
def test_rest_api_subagent_steer_and_stop(client, temp_ws):
    """测试 REST 接口 /api/chat/{session_id}/subagents/{agent_id}/steer 与 stop"""
    # 1. 注册一个受控子代理
    sub_ctrl = PreemptiveController(session_id="subagent_api_test")
    info = SubagentInfo(
        agent_id="subagent_api_test",
        parent_call_id="call_root_1",
        session_id="session_api_1",
        mode="explore",
        task="API测试子代理",
        status="RUNNING",
        controller=sub_ctrl,
    )
    multi_agent_mesh.agents["subagent_api_test"] = info

    # 2. 测试 steer 接口 (兼容 message 或 content 字段)
    steer_payload = {"message": "请转向排查日志", "interrupt": True}
    resp = client.post(
        "/api/chat/session_api_1/subagents/subagent_api_test/steer",
        json=steer_payload,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert sub_ctrl.has_steer() is True
    assert sub_ctrl.consume_steer() == "请转向排查日志"

    # 3. 测试 stop 接口
    resp_stop = client.post(
        "/api/chat/session_api_1/subagents/subagent_api_test/stop"
    )
    assert resp_stop.status_code == 200
    data_stop = resp_stop.json()
    assert data_stop["success"] is True
    assert info.status == "TERMINATED"


# ==============================================================================
# 6. handle_stream 真实多路复用流与 PTY SSE 全链路回归测试
# ==============================================================================
@pytest.mark.anyio
async def test_chat_service_multiplexed_subagent_and_pty_sse(temp_ws):
    """验证 chat_service.handle_stream 能将 spawn_agent 后台子代理事件与 PTY terminal_output 实时多路复用进主 SSE 流"""
    import json
    from models.schemas.chat import ChatRequest
    from services.chat_service import ChatService
    from services.llm_adapter import StreamChunk
    from services.terminal_manager import TerminalManager

    msg_repo = MagicMock()
    msg_repo.create = AsyncMock(side_effect=lambda **kw: {"id": "msg_mock"})
    msg_repo.update_metrics = AsyncMock()
    sess_repo = MagicMock()
    sess_repo.get_by_id = AsyncMock(return_value={"id": "sess_mux", "title": "已有标题"})

    call_round = 0

    async def fake_stream_chat(**kwargs):
        nonlocal call_round
        call_round += 1
        if call_round == 1:
            yield StreamChunk(type="tool_start", tool_call_id="call_spawn_mux", tool_name="workspace__spawn_agent")
            yield StreamChunk(
                type="tool_finish",
                tool_call_id="call_spawn_mux",
                tool_name="workspace__spawn_agent",
                arguments={"task": "检查模块", "mode": "explore"},
            )
            yield StreamChunk(type="tool_start", tool_call_id="call_pty_mux", tool_name="workspace__exec_command")
            yield StreamChunk(
                type="tool_finish",
                tool_call_id="call_pty_mux",
                tool_name="workspace__exec_command",
                arguments={"cmd": "echo MUX_PTY_OK", "yield_time_ms": 2000},
            )
            yield StreamChunk(type="finish", finish_reason="tool_calls", input_tokens=10, output_tokens=10)
        elif call_round == 2:
            aids = list(multi_agent_mesh.agents.keys())
            assert len(aids) == 1
            yield StreamChunk(type="tool_start", tool_call_id="call_wait_mux", tool_name="workspace__wait_agent")
            yield StreamChunk(
                type="tool_finish",
                tool_call_id="call_wait_mux",
                tool_name="workspace__wait_agent",
                arguments={"agent_ids": aids, "timeout_ms": 3000},
            )
            yield StreamChunk(type="finish", finish_reason="tool_calls", input_tokens=10, output_tokens=10)
        else:
            yield StreamChunk(type="text", text="全部完成")
            yield StreamChunk(type="finish", finish_reason="stop", input_tokens=10, output_tokens=10)

    llm = MagicMock()
    llm.stream_chat = fake_stream_chat

    ctx = MagicMock()
    ctx.build_context = AsyncMock(return_value=[{"role": "user", "content": "hi"}])
    ctx.compiler = MagicMock()
    ctx.compiler.attach_working_memory_to_messages = MagicMock(
        side_effect=lambda **kw: (kw["messages"], None, None)
    )
    ctx.compiler.last_telemetry_sse = None
    ctx.compiler.last_telemetry = None
    ctx.gate_tool_output = lambda s: s

    svc = ChatService(message_repo=msg_repo, session_repo=sess_repo, llm=llm, ctx_mgr=ctx)
    svc.resolve_workspace_root = AsyncMock(return_value=temp_ws)
    svc.collect_tools = AsyncMock(return_value=([], {}))

    captured: dict[str, Any] = {}

    async def mock_worker(info: SubagentInfo, **kw):
        pe = kw.get("parent_emitter")
        captured["parent_call_id"] = info.parent_call_id
        captured["api_key"] = kw.get("api_key")
        captured["has_emitter"] = pe is not None
        await asyncio.sleep(0.03)
        pe.emit_sse(
            event="subagent_progress",
            payload={"agent_id": info.agent_id, "step": 1, "status": "thinking"},
            agent_id=info.agent_id,
            parent_call_id=info.parent_call_id,
        )
        pe.emit_sse(
            event="reasoning_delta",
            payload={"text": "子代理思考", "agent_id": info.agent_id},
            agent_id=info.agent_id,
            parent_call_id=info.parent_call_id,
        )
        info.summary = "完成"
        info.status = "COMPLETED"
        multi_agent_mesh.lock_manager.release(info.agent_id)

    req = ChatRequest(content="测试多路复用", model="test-model", api_key="sk-mux", mode="act")
    events: list[dict[str, Any]] = []
    try:
        with patch.object(multi_agent_mesh, "_subagent_worker_loop", side_effect=mock_worker):
            async for sse in svc.handle_stream(session_id="sess_mux", req=req, user_id="u1"):
                for line in sse.splitlines():
                    if line.startswith("data: "):
                        events.append(json.loads(line[6:]))
    finally:
        TerminalManager.get_instance().cleanup_all()

    assert captured["parent_call_id"] == "call_spawn_mux"
    assert captured["api_key"] == "sk-mux"
    assert captured["has_emitter"] is True

    sub_events = [e for e in events if str(e.get("agent_id", "")).startswith("subagent_")]
    pty_events = [
        e for e in events if e.get("channel") == "workbench_pty" and e.get("event") == "terminal_output"
    ]
    seqs = [e["seq"] for e in events if "seq" in e]
    assert len(sub_events) == 2
    assert all(e.get("parent_call_id") == "call_spawn_mux" for e in sub_events)
    assert len(pty_events) >= 1
    assert any("MUX_PTY_OK" in e.get("payload", {}).get("output", "") for e in pty_events)
    assert len(seqs) == len(set(seqs))

