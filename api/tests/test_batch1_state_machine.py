import asyncio
import json
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

import pytest

from models.schemas.chat import ChatRequest, SSEEventName, SteeringRequest
from models.schemas.stream_envelope import (
    AgentLifecycleState,
    AgentRunMode,
    EnvelopeEmitter,
    StreamChannel,
    StreamEnvelope,
)
from repositories.message_repository import MessageRepository
from repositories.session_repository import SessionRepository
from services.agent_state_machine import (
    AgentStateMachine,
    InvalidStateTransitionError,
    PreemptiveController,
    ToolRegistry,
    tool_registry,
)
from services.chat_service import ChatService
from services.context_manager import ContextManager
from services.llm_adapter import LLMAdapter, StreamChunk
from services.workspace_tool_executor import WorkspaceToolExecutor


def _parse_sse_frame(raw_sse: str) -> tuple[str, dict[str, Any]]:
    event_name = ""
    data_str = ""
    for line in raw_sse.strip().split("\n"):
        if line.startswith("event:"):
            event_name = line[6:].strip()
        elif line.startswith("data:"):
            data_str = line[5:].strip()
    return event_name, json.loads(data_str)


# ============================================================================
# 1. StreamEnvelope 序列化与顶层旧字段平铺兼容测试
# ============================================================================


def test_stream_envelope_serialization_and_legacy_flat_compat():
    """验证 EnvelopeEmitter 输出的 SSE 既包含完整 StreamEnvelope 字段，又将 payload 平铺到顶层"""
    emitter = EnvelopeEmitter(turn_id="turn_batch1_test")

    sse_1 = emitter.emit_sse(
        event=SSEEventName.TEXT_DELTA.value,
        payload={"delta": "Hello World", "step": 1},
        channel=StreamChannel.CHAT,
    )
    evt_1, data_1 = _parse_sse_frame(sse_1)

    # 外层 SSE event 名称对齐
    assert evt_1 == "text_delta"
    # 新版信封字段完整
    assert data_1["seq"] == 1
    assert data_1["turn_id"] == "turn_batch1_test"
    assert data_1["agent_id"] == "root"
    assert data_1["parent_call_id"] is None
    assert data_1["channel"] == "chat"
    assert data_1["event"] == "text_delta"
    assert data_1["payload"] == {"delta": "Hello World", "step": 1}
    assert isinstance(data_1["timestamp"], int)
    # 旧版平铺字段 100% 兼容
    assert data_1["delta"] == "Hello World"
    assert data_1["step"] == 1

    # 反序列化为 StreamEnvelope 强类型模型验证
    env_model = StreamEnvelope.model_validate(data_1)
    assert env_model.seq == 1
    assert env_model.channel == StreamChannel.CHAT
    assert env_model.payload["delta"] == "Hello World"

    # 第 2 帧验证 seq 严格递增与子代理元数据传递
    sse_2 = emitter.emit_sse(
        event=SSEEventName.TOOL_CALL_RESULT.value,
        payload={"tool_call_id": "tc_001", "result": {"ok": True}, "is_error": False},
        channel=StreamChannel.WORKBENCH_DIFF,
        agent_id="subagent_alpha",
        parent_call_id="call_parent_1",
    )
    evt_2, data_2 = _parse_sse_frame(sse_2)
    assert evt_2 == "tool_call_result"
    assert data_2["seq"] == 2
    assert data_2["agent_id"] == "subagent_alpha"
    assert data_2["parent_call_id"] == "call_parent_1"
    assert data_2["channel"] == "workbench_diff"
    assert data_2["tool_call_id"] == "tc_001"
    assert data_2["result"] == {"ok": True}


# ============================================================================
# 2. PLANNING 模式下硬门控拦截 mutating=True 工具并放行只读工具测试
# ============================================================================


@pytest.mark.anyio
async def test_plan_mode_blocks_mutating_tools_and_allows_read_file():
    """验证 PLANNING 状态下拦截 write_file/edit_file/delete_file/execute_command，且放行 read_file"""
    with tempfile.TemporaryDirectory() as tmp_dir:
        sample_file = Path(tmp_dir) / "existing.py"
        sample_file.write_text("print('hello genesis')\n", encoding="utf-8")

        sm = AgentStateMachine(
            session_id="sess_plan_gate",
            mode=AgentRunMode.PLAN,
        )
        assert sm.state == AgentLifecycleState.PLANNING

        # 1. 只读工具 read_file 正常放行
        read_res = await sm.execute_tool_call(
            tool_name="workspace__read_file",
            tool_args={"path": "existing.py"},
            workspace_root=tmp_dir,
        )
        assert read_res["success"] is True
        assert "hello genesis" in read_res["content"]

        # 2. 修改类工具 write_file 被硬门控拦截且不写入磁盘
        write_res = await sm.execute_tool_call(
            tool_name="workspace__write_file",
            tool_args={"path": "forbidden.py", "content": "hacked = True"},
            workspace_root=tmp_dir,
        )
        assert write_res["success"] is False
        assert "[Plan Mode Gate]" in write_res["error"]
        assert "<proposed_plan>" in write_res["error"]
        assert not (Path(tmp_dir) / "forbidden.py").exists()

        # 3. edit_file / delete_file / execute_command / todo_write 均被拦截
        for mutating_tool, args in [
            (
                "workspace__edit_file",
                {"path": "existing.py", "old_string": "hello", "new_string": "bye"},
            ),
            ("workspace__delete_file", {"path": "existing.py"}),
            ("workspace__execute_command", {"command": "rm -rf existing.py"}),
            (
                "workspace__todo_write",
                {"todos": [{"id": "1", "content": "x", "status": "pending"}]},
            ),
        ]:
            res = await sm.execute_tool_call(
                tool_name=mutating_tool,
                tool_args=args,
                workspace_root=tmp_dir,
            )
            assert res["success"] is False
            assert "[Plan Mode Gate]" in res["error"]

        # 原文件毫发无损
        assert sample_file.read_text(encoding="utf-8") == "print('hello genesis')\n"


# ============================================================================
# 3. <proposed_plan> 检测与 AWAITING_PLAN_APPROVAL 状态跃迁及非法跃迁校验
# ============================================================================


def test_proposed_plan_detection_and_state_transition():
    """验证检测到 <proposed_plan>...</proposed_plan> 时自动提取计划并跃迁至 AWAITING_PLAN_APPROVAL"""
    sm = AgentStateMachine(session_id="sess_plan_detect", mode=AgentRunMode.PLAN)
    assert sm.state == AgentLifecycleState.PLANNING

    llm_output = (
        "经过代码探索，我建议按以下步骤重构：\n"
        "<proposed_plan>\n"
        "1. 新增 stream_envelope.py 定义统一信封\n"
        "2. 新增 agent_state_machine.py 实现状态机与抢占控制\n"
        "3. 重构 chat_service.py 收敛工具调用\n"
        "</proposed_plan>\n"
        "请确认是否切换到 ACT 模式执行。"
    )

    plan_payload = sm.detect_proposed_plan(llm_output, step=2)
    assert plan_payload is not None
    assert sm.state == AgentLifecycleState.AWAITING_PLAN_APPROVAL
    assert plan_payload["state"] == AgentLifecycleState.AWAITING_PLAN_APPROVAL.value
    assert "stream_envelope.py" in plan_payload["plan"]
    assert plan_payload["plan_id"].startswith("plan_")

    # 验证批准计划后可切换到 ACT 模式并进入 COMPILING_CONTEXT
    sm.approve_plan(plan_payload["plan_id"])
    assert sm.mode == AgentRunMode.ACT
    assert sm.state == AgentLifecycleState.COMPILING_CONTEXT

    # 验证非法状态跃迁抛出 InvalidStateTransitionError
    sm.transition_to(AgentLifecycleState.COMPLETED, reason="finish")
    with pytest.raises(InvalidStateTransitionError):
        sm.transition_to(AgentLifecycleState.EXECUTING_TOOLS, reason="illegal_jump")


@pytest.mark.anyio
async def test_chat_service_plan_mode_end_to_end_preserves_tools_schema():
    """验证 ChatService 在 mode='plan' 下不删减传给 LLM 的 tools 列表，拦截写操作并在输出 <proposed_plan> 时广播 PLAN_PROPOSED"""
    with tempfile.TemporaryDirectory() as tmp_dir:
        (Path(tmp_dir) / "app.py").write_text("x = 1\n", encoding="utf-8")

        captured_tools_per_step: list[list[str]] = []

        class PlanModeMockLLM(LLMAdapter):
            def __init__(self):
                super().__init__()
                self.step = 0

            async def stream_chat(
                self,
                messages: list[dict[str, Any]],
                tools: Optional[list[dict[str, Any]]] = None,
                **kwargs: Any,
            ) -> AsyncGenerator[StreamChunk, None]:
                if tools is None:
                    yield StreamChunk(type="text", text="规划标题")
                    yield StreamChunk(type="finish", finish_reason="stop")
                    return
                self.step += 1
                captured_tools_per_step.append(
                    [t["function"]["name"] for t in (tools or [])]
                )
                if self.step == 1:
                    # Step 1: 尝试在 plan 模式下调用 write_file (应被拦截) 并调用 read_file (应放行)
                    yield StreamChunk(
                        type="tool_start",
                        tool_call_id="tc_write_blocked",
                        tool_name="workspace__write_file",
                    )
                    yield StreamChunk(
                        type="tool_finish",
                        tool_call_id="tc_write_blocked",
                        tool_name="workspace__write_file",
                        arguments={"path": "app.py", "content": "x = 999\n"},
                    )
                    yield StreamChunk(
                        type="tool_start",
                        tool_call_id="tc_read_ok",
                        tool_name="workspace__read_file",
                    )
                    yield StreamChunk(
                        type="tool_finish",
                        tool_call_id="tc_read_ok",
                        tool_name="workspace__read_file",
                        arguments={"path": "app.py"},
                    )
                    yield StreamChunk(type="finish", finish_reason="tool_calls")
                else:
                    # Step 2: 收到拦截提示后输出 <proposed_plan>
                    yield StreamChunk(
                        type="text",
                        text="已了解处于只读模式。\n<proposed_plan>\n修改 app.py 将 x 设为 999\n</proposed_plan>",
                    )
                    yield StreamChunk(type="finish", finish_reason="stop")

        service = ChatService(llm=PlanModeMockLLM())
        req = ChatRequest(
            content="请规划如何修改 app.py",
            mode="plan",
            workspace_path=tmp_dir,
        )
        raw_events: list[str] = []
        async for sse in service.handle_stream(
            session_id="sess_plan_e2e",
            req=req,
            user_id="user_plan_test",
        ):
            raw_events.append(sse)

        # 1. 验证传给 LLM 的 tools 完整包含写工具（未删减 Schema，保护 Prompt Cache）
        assert len(captured_tools_per_step) == 2
        assert "workspace__write_file" in captured_tools_per_step[0]
        assert "workspace__read_file" in captured_tools_per_step[0]

        # 2. 验证磁盘上 app.py 未被修改
        assert (Path(tmp_dir) / "app.py").read_text(encoding="utf-8") == "x = 1\n"

        # 3. 验证 PLAN_PROPOSED 事件与 AWAITING_PLAN_APPROVAL 状态被正确推送
        parsed = [_parse_sse_frame(e) for e in raw_events]
        plan_events = [d for ev, d in parsed if ev == SSEEventName.PLAN_PROPOSED.value]
        assert len(plan_events) == 1
        assert plan_events[0]["channel"] == StreamChannel.PLAN_STATE.value
        assert "修改 app.py 将 x 设为 999" in plan_events[0]["plan"]
        assert plan_events[0]["state"] == AgentLifecycleState.AWAITING_PLAN_APPROVAL.value


# ============================================================================
# 4. 慢工具执行期间收到 trigger_steer(preempt=True) 在 100ms 内抢占中断与半截输出恢复测试
# ============================================================================


@pytest.mark.anyio
async def test_preemptive_controller_interrupts_slow_tool_under_100ms_and_recovers():
    """验证慢工具 (5s) 执行期间收到 trigger_steer(preempt=True) 在 100ms 内抢占中断并注入半截输出恢复下一轮推理"""
    local_registry = ToolRegistry()

    @local_registry.register(
        name="workspace__slow_build",
        description="模拟耗时 5 秒的慢构建工具",
        parameters_schema={"type": "object", "properties": {}},
        mutating=True,
        timeout_sec=10.0,
    )
    async def _slow_build_tool(
        workspace_root: str,
        tc_args: dict[str, Any],
        controller: Optional[PreemptiveController] = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        if controller:
            controller.append_partial_stdout("Compiling module 1/10... OK")
        await asyncio.sleep(5.0)
        return {"success": True, "stdout": "Build finished"}

    controller = PreemptiveController(session_id="sess_preempt_fast")
    sm = AgentStateMachine(
        session_id="sess_preempt_fast",
        mode=AgentRunMode.ACT,
        registry=local_registry,
        controller=controller,
    )
    sm.transition_to(AgentLifecycleState.COMPILING_CONTEXT, reason="init")
    sm.transition_to(AgentLifecycleState.STREAMING_LLM, reason="llm")

    async def _trigger_user_preempt():
        await asyncio.sleep(0.015)  # 15ms 后触发微秒级抢占插话
        t_steer_start = time.perf_counter()
        controller.trigger_steer("停止构建，改为只运行单测", preempt=True)
        return t_steer_start

    steer_task = asyncio.create_task(_trigger_user_preempt())
    res = await sm.execute_tool_call(
        tool_name="workspace__slow_build",
        tool_args={},
        controller=controller,
        step=1,
    )
    t_finished = time.perf_counter()
    t_steer_start = await steer_task

    preempt_latency_ms = (t_finished - t_steer_start) * 1000.0
    assert preempt_latency_ms < 100.0, f"抢占中断耗时超过 100ms: {preempt_latency_ms:.2f}ms"
    assert res["preempted"] is True
    assert sm.state == AgentLifecycleState.INTERRUPTED
    assert (
        "[Interrupted by user at step 1 | Partial output preserved: Compiling module 1/10... OK]"
        in res["recovery_anchor"]
    )
    steered_msgs = controller.drain_steering_messages()
    assert steered_msgs == ["停止构建，改为只运行单测"]


@pytest.mark.anyio
async def test_chat_service_end_to_end_preemptive_steer_during_slow_tool():
    """验证 ChatService.handle_stream 在慢工具执行中收到抢占插话时，100ms 内中断慢工具并带着恢复锚点进入 Step 2"""

    @tool_registry.register(
        name="workspace__mock_slow_task",
        description="测试用慢速任务",
        parameters_schema={"type": "object", "properties": {}},
        mutating=False,
        timeout_sec=10.0,
    )
    async def _mock_slow_task(
        workspace_root: str,
        tc_args: dict[str, Any],
        controller: Optional[PreemptiveController] = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        if controller:
            controller.append_partial_stdout("Step A completed (50%)")
        await asyncio.sleep(5.0)
        return {"success": True}

    tool_started_event = asyncio.Event()
    step2_received_messages: list[dict[str, Any]] = []

    class PreemptMockLLM(LLMAdapter):
        def __init__(self):
            super().__init__()
            self.call_idx = 0

        async def stream_chat(
            self,
            messages: list[dict[str, Any]],
            tools: Optional[list[dict[str, Any]]] = None,
            **kwargs: Any,
        ) -> AsyncGenerator[StreamChunk, None]:
            self.call_idx += 1
            if self.call_idx == 1:
                yield StreamChunk(type="text", text="开始执行慢任务...")
                yield StreamChunk(
                    type="tool_start",
                    tool_call_id="call_slow_1",
                    tool_name="workspace__mock_slow_task",
                )
                yield StreamChunk(
                    type="tool_finish",
                    tool_call_id="call_slow_1",
                    tool_name="workspace__mock_slow_task",
                    arguments={},
                )
                yield StreamChunk(type="finish", finish_reason="tool_calls")
                tool_started_event.set()
            else:
                step2_received_messages.extend(messages)
                yield StreamChunk(
                    type="text",
                    text="已根据您的插话中断慢任务并保留半截进度，现切换至快速方案。",
                )
                yield StreamChunk(type="finish", finish_reason="stop")

    service = ChatService(llm=PreemptMockLLM())
    user_id = "user_preempt_e2e"
    session_id = f"sess_preempt_{uuid.uuid4().hex[:8]}"

    async def _MockTitle(*args: Any, **kwargs: Any) -> Optional[str]:
        return None

    service.generate_session_title = _MockTitle  # type: ignore

    steer_triggered_at = 0.0
    tool_preempted_at = 0.0

    async def _steer_trigger():
        nonlocal steer_triggered_at
        await tool_started_event.wait()
        await asyncio.sleep(0.015)  # 等待慢工具进入 sleep(5.0)
        steer_triggered_at = time.perf_counter()
        ok = service.add_steering_message(
            user_id,
            session_id,
            "无需等待慢任务，直接输出快速方案",
            preempt=True,
        )
        assert ok is True

    steer_worker = asyncio.create_task(_steer_trigger())
    req = ChatRequest(content="执行慢任务")
    collected_frames: list[tuple[str, dict[str, Any]]] = []

    async for raw_sse in service.handle_stream(
        session_id=session_id,
        req=req,
        user_id=user_id,
    ):
        ev_name, ev_data = _parse_sse_frame(raw_sse)
        if ev_name == SSEEventName.PREEMPTED.value and tool_preempted_at == 0.0:
            tool_preempted_at = time.perf_counter()
        collected_frames.append((ev_name, ev_data))

    await steer_worker
    tool_registry._tools.pop("workspace__mock_slow_task", None)

    assert steer_triggered_at > 0
    assert tool_preempted_at > 0
    latency_ms = (tool_preempted_at - steer_triggered_at) * 1000.0
    assert latency_ms < 100.0, f"端到端抢占耗时超过 100ms: {latency_ms:.2f}ms"

    # 验证 PREEMPTED 事件包含恢复锚点与半截输出
    preempt_evts = [d for ev, d in collected_frames if ev == SSEEventName.PREEMPTED.value]
    assert len(preempt_evts) == 1
    anchor = preempt_evts[0]["recovery_anchor"]
    assert "[Interrupted by user at step 1 | Partial output preserved:" in anchor
    assert "Step A completed (50%)" in anchor

    # 验证 Step 2 的 LLM 上下文中注入了恢复锚点与用户插话指令
    serialized_ctx = json.dumps(step2_received_messages, ensure_ascii=False)
    assert "[Interrupted by user at step 1 | Partial output preserved:" in serialized_ctx
    assert "无需等待慢任务，直接输出快速方案" in serialized_ctx


# ============================================================================
# 5. PreemptiveController 活跃 PTY 会话 SIGINT (\x03) 透传与 Bridge 路由测试
# ============================================================================


def test_preemptive_controller_sends_sigint_to_active_pty(monkeypatch):
    """验证 trigger_steer(preempt=True) 时自动向绑定的活跃 PTY 会话发送 \\x03 (SIGINT)"""
    from services.terminal_manager import TerminalManager

    written_bytes: list[bytes | str] = []

    class FakePtySession:
        def is_alive(self) -> bool:
            return True

        def write(self, data: bytes | str) -> None:
            written_bytes.append(data)

    tm = TerminalManager.get_instance()
    monkeypatch.setattr(
        tm,
        "get_session",
        lambda sid: FakePtySession() if sid == "pty_test_01" else None,
    )

    ctrl = PreemptiveController(session_id="sess_pty_sigint")
    ctrl.active_pty_session_ids.add("pty_test_01")
    ctrl.trigger_steer("中断前台命令", preempt=True)

    assert b"\x03" in written_bytes
    assert ctrl.preempt_event.is_set() is True


@pytest.mark.anyio
async def test_state_machine_bridge_rpc_routing(monkeypatch):
    """验证当 workspace_root 以 bridge:// 开头时，AgentStateMachine 自动路由至 BridgeManager.call_rpc"""
    from services.bridge_manager import BridgeManager

    called_rpc: list[tuple[str, str, dict[str, Any]]] = []

    async def _fake_call_rpc(uid: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
        called_rpc.append((uid, method, params))
        return {"success": True, "content": "bridged file content"}

    bm = BridgeManager.get_instance()
    monkeypatch.setattr(bm, "call_rpc", _fake_call_rpc)

    sm = AgentStateMachine(session_id="sess_bridge", mode=AgentRunMode.ACT)
    res = await sm.execute_tool_call(
        tool_name="workspace__read_file",
        tool_args={"path": "README.md"},
        workspace_root="bridge://user_42::/Users/dev/proj",
        user_id="user_42",
    )
    assert res["success"] is True
    assert res["content"] == "bridged file content"
    assert called_rpc == [("user_42", "fs.readFile", {"path": "README.md"})]
