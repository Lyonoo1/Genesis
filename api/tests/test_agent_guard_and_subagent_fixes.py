import asyncio
import json
import uuid
from typing import Any, AsyncGenerator, Optional

import pytest

from core.exceptions import AppException, ErrorCode
from core.sqlite_db import db_upsert_model, init_sqlite_db
from models.schemas.chat import ChatRequest
from models.schemas.stream_envelope import EnvelopeEmitter
from services.agent_guard import (
    DoomLoopDetector,
    extract_clean_error,
    infer_model_context_window,
    resolve_effective_model_credentials,
)
from services.chat_service import ChatService
from services.context_manager import ContextManager
from services.llm_adapter import StreamChunk
from services.multi_agent_mesh import MultiAgentMesh
from tests.test_chat_react import (
    MockLLMAdapter,
    MockMcpClientManager,
    MockMcpRepository,
    MockMessageRepository,
    MockSkillRepository,
)


def test_infer_model_context_window():
    # DeepSeek 历史硬编码 1M 必须纠偏为 128K
    assert infer_model_context_window("deepseek-flash", 1048576) == 131072
    assert infer_model_context_window("deepseek-chat", None) == 131072
    # Gemini 支持 1M
    assert infer_model_context_window("gemini-2.5-pro", 1048576) == 1048576
    # Claude 200K
    assert infer_model_context_window("claude-3-7-sonnet", None) == 200000
    # 显式自定义非 1M 窗口保持尊重
    assert infer_model_context_window("deepseek-chat", 65536) == 65536


def test_extract_clean_error_no_raw_python_dict():
    exc = AppException(
        code=ErrorCode.VALIDATION_ERROR,
        message="未配置有效 API Key，请在模型配置面板中填入你的 API Key",
    )
    code, msg = extract_clean_error(exc)
    assert code == "VALIDATION_ERROR"
    assert msg == "未配置有效 API Key，请在模型配置面板中填入你的 API Key"
    assert "{" not in msg

    # 兜底解析历史字符串形式
    raw_err = RuntimeError(
        "400: {'error': {'code': 'VALIDATION_ERROR', 'message': '未配置有效 API Key', 'details': None}}"
    )
    code2, msg2 = extract_clean_error(raw_err)
    assert code2 == "VALIDATION_ERROR"
    assert msg2 == "未配置有效 API Key"


def test_doom_loop_detector_allows_normal_25_steps():
    detector = DoomLoopDetector()
    for i in range(25):
        res = detector.record_step(
            [
                {
                    "name": "workspace__read_file",
                    "args": {"path": f"src/module_{i}.py"},
                    "is_error": False,
                    "output": {"content": f"file content {i}"},
                }
            ]
        )
        assert res.triggered is False


def test_doom_loop_detector_ping_pong_and_escalation():
    detector = DoomLoopDetector()
    step_a = [{"name": "workspace__read_file", "args": {"path": "a.py"}, "is_error": False, "output": "a"}]
    step_b = [{"name": "workspace__read_file", "args": {"path": "b.py"}, "is_error": False, "output": "b"}]

    assert detector.record_step(step_a).triggered is False
    assert detector.record_step(step_b).triggered is False
    assert detector.record_step(step_a).triggered is False
    # A-B-A-B 首次触发 soft_nudge
    r4 = detector.record_step(step_b)
    assert r4.triggered is True
    assert r4.severity == "soft_nudge"
    # 继续重复升级为 hard_stop
    r5 = detector.record_step(step_a)
    assert r5.triggered is True
    assert r5.severity == "hard_stop"


@pytest.mark.anyio
async def test_chat_service_runs_over_20_distinct_steps_without_premature_stop():
    """验证正常有进展的 25 步多工具调用不会被旧版 20 步上限腰斩"""
    session_id = uuid.uuid4()
    msg_repo = MockMessageRepository()

    steps = []
    for i in range(25):
        steps.append(
            [
                StreamChunk(type="tool_start", tool_call_id=f"call_{i}", tool_name="mcp__github__get_repo"),
                StreamChunk(
                    type="tool_finish",
                    tool_call_id=f"call_{i}",
                    tool_name="mcp__github__get_repo",
                    arguments={"repo": f"repo_{i}"},
                ),
                StreamChunk(type="finish", finish_reason="tool_calls"),
            ]
        )
    steps.append(
        [
            StreamChunk(type="text", text="全部 25 个仓库已核查完毕。"),
            StreamChunk(type="finish", finish_reason="stop"),
        ]
    )

    service = ChatService(
        message_repo=msg_repo,
        skill_repo=MockSkillRepository(),
        mcp_repo=MockMcpRepository(),
        llm=MockLLMAdapter(step_responses=steps),
        mcp_manager=MockMcpClientManager(),
        ctx_mgr=ContextManager(message_repo=msg_repo),
    )

    req = ChatRequest(content="依次检查 25 个仓库", model="deepseek-chat")
    events = []
    async for raw in service.handle_stream(session_id, req, "user-25-steps"):
        events.append(raw)

    full_output = "".join(events)
    assert "全部 25 个仓库已核查完毕" in full_output
    assert "doom_loop_stopped" not in full_output
    assert "step_budget_reached" not in full_output


@pytest.mark.anyio
async def test_subagent_failure_never_fakes_completed():
    """验证子代理遭遇 API Key 校验失败时，状态必须为 FAILED 且推送 failed 事件，绝不伪装 COMPLETED"""

    class FailingLLM:
        async def stream_chat(self, **kwargs: Any) -> AsyncGenerator[StreamChunk, None]:
            if False:
                yield StreamChunk(type="text", text="")
            raise AppException(
                code=ErrorCode.VALIDATION_ERROR,
                message="未配置有效 API Key，请在模型配置面板中填入你的 API Key",
            )

    mesh = MultiAgentMesh(llm=FailingLLM())  # type: ignore[arg-type]
    queue: asyncio.Queue[str] = asyncio.Queue()
    emitter = EnvelopeEmitter().fork_queued(queue)

    spawn_res = await mesh.spawn_agent(
        task="调研前端架构",
        mode="explore",
        workspace_root=".",
        session_id="sess-fail-check",
        parent_emitter=emitter,
        model="deepseek-chat",
        api_key=None,
    )
    aid = spawn_res["agent_id"]
    wait_res = await mesh.wait_agent([aid], timeout_ms=5000)

    agent_snap = wait_res["completed"][aid]
    assert agent_snap["status"] == "FAILED"
    assert agent_snap["success"] is False
    assert agent_snap["error_code"] == "VALIDATION_ERROR"
    assert "未配置有效 API Key" in agent_snap["error"]
    assert "[子代理执行完成]" not in (agent_snap["summary"] or "")

    # 校验 SSE 事件流中确实收到了 status="failed" 且没有任何 status="completed"
    emitted_frames: list[str] = []
    while not queue.empty():
        emitted_frames.append(queue.get_nowait())
    joined = "".join(emitted_frames)
    assert '"status": "failed"' in joined
    assert '"error_code": "VALIDATION_ERROR"' in joined
    assert '"status": "completed"' not in joined


@pytest.mark.anyio
async def test_subagent_resolves_api_key_from_saved_model_configs():
    """验证即使未显式传 api_key，子代理也会从用户已保存的 model_configs 回查凭据并成功完成"""
    init_sqlite_db()
    uid = f"user-cred-{uuid.uuid4().hex[:8]}"
    db_upsert_model(
        uid,
        {
            "id": f"m-{uuid.uuid4().hex[:6]}",
            "name": "DeepSeek",
            "modelId": "deepseek-chat",
            "provider": "openai",
            "baseUrl": "https://api.deepseek.com",
            "apiKey": "sk-test-resolved-secret",
            "isDefault": True,
            "contextWindow": 131072,
        },
    )

    captured_kwargs: dict[str, Any] = {}

    class CapturingLLM:
        async def stream_chat(self, **kwargs: Any) -> AsyncGenerator[StreamChunk, None]:
            captured_kwargs.update(kwargs)
            yield StreamChunk(type="text", text="前端采用 Next.js 14 + Zustand + Tailwind。")
            yield StreamChunk(type="finish", finish_reason="stop")

    mesh = MultiAgentMesh(llm=CapturingLLM())  # type: ignore[arg-type]
    spawn_res = await mesh.spawn_agent(
        task="分析前端栈",
        mode="explore",
        workspace_root=".",
        session_id="sess-cred-ok",
        model="deepseek-chat",
        api_key=None,
        user_id=uid,
    )
    aid = spawn_res["agent_id"]
    wait_res = await mesh.wait_agent([aid], timeout_ms=5000)

    assert captured_kwargs.get("api_key") == "sk-test-resolved-secret"
    assert captured_kwargs.get("base_url") == "https://api.deepseek.com"
    assert wait_res["completed"][aid]["status"] == "COMPLETED"
    assert wait_res["completed"][aid]["success"] is True
    assert "Next.js 14" in wait_res["completed"][aid]["summary"]
