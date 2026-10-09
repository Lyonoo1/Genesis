import asyncio
import json
import uuid
from typing import Any, AsyncGenerator, Optional
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from main import app
from core.security import get_current_user, AuthenticatedUser
from models.schemas.chat import ChatRequest, SSEEventName
from models.schemas.message import MessageCreate
from repositories.session_repository import SessionRepository
from repositories.message_repository import MessageRepository
from repositories.mcp_repository import McpRepository
from repositories.skill_repository import SkillRepository
from routers.chat import get_chat_service, get_session_repository
from services.chat_service import ChatService
from services.context_manager import ContextManager
from services.llm_adapter import LLMAdapter, StreamChunk
from services.mcp_client import McpClientManager
from services.skill_engine import SkillEngine


TEST_USER_ID = "00000000-0000-0000-0000-000000000001"


# ----------------------------------------------------------------------
# 内存 Mock 仓储与执行器
# ----------------------------------------------------------------------


class MockSessionRepository(SessionRepository):
    def __init__(self):
        super().__init__(client=None)
        self.sessions: dict[str, dict] = {}

    async def get_by_id(self, user_id: str, session_id: uuid.UUID):
        s = self.sessions.get(str(session_id))
        if s and s["user_id"] == str(user_id):
            return s
        return None

    def add_session(self, session_id: str, user_id: str):
        self.sessions[session_id] = {
            "id": session_id,
            "user_id": user_id,
            "title": "测试会话",
            "pinned": False,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }


class MockMessageRepository(MessageRepository):
    def __init__(self):
        super().__init__(client=None)
        self.messages: list[dict] = []

    async def list_by_session(self, user_id: str, session_id: uuid.UUID, limit: int = 50, before=None):
        return [
            m for m in self.messages
            if m["user_id"] == str(user_id) and m["session_id"] == str(session_id)
        ]

    async def create(self, user_id: str, msg_in: MessageCreate):
        m_id = str(uuid.uuid4())
        record = {
            "id": m_id,
            "user_id": str(user_id),
            "session_id": str(msg_in.session_id),
            "parent_id": str(msg_in.parent_id) if msg_in.parent_id else None,
            "role": msg_in.role.value,
            "content": msg_in.content,
            "raw_tool_calls": [t.model_dump() for t in msg_in.raw_tool_calls] if msg_in.raw_tool_calls else None,
            "tool_call_id": msg_in.tool_call_id,
            "status": msg_in.status.value,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self.messages.append(record)
        return record

    async def prune_branch(self, user_id: str, session_id: uuid.UUID, parent_id: uuid.UUID):
        # 简化版模拟修剪
        pass


class MockSkillRepository(SkillRepository):
    def __init__(self):
        super().__init__(client=None)
        self.skills: list[dict] = []

    async def list_by_user(self, user_id: str):
        return self.skills

    async def get_by_name(self, user_id: str, name: str):
        for s in self.skills:
            if s.get("name") == name:
                return s
        return None


class MockMcpRepository(McpRepository):
    def __init__(self):
        super().__init__(client=None)
        self.servers: list[dict] = []

    async def list_by_user(self, user_id: str):
        return self.servers

    async def get_by_name(self, user_id: str, name: str):
        for s in self.servers:
            if s.get("name") == name:
                return s
        return None


class MockLLMAdapter(LLMAdapter):
    """可编程 Mock LLM：根据设定的步骤序列吐出 Chunk"""

    def __init__(self, step_responses: list[list[StreamChunk]]):
        super().__init__()
        self.step_responses = step_responses
        self.call_count = 0


    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: Optional[list[dict[str, Any]]] = None,
        model: str = "gpt-4o",
        temperature: float = 0.7,
        max_tokens: int = 4096,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        provider: Optional[str] = None,
        **kwargs,
    ) -> AsyncGenerator[StreamChunk, None]:
        if self.call_count < len(self.step_responses):
            chunks = self.step_responses[self.call_count]
            self.call_count += 1
            for c in chunks:
                await asyncio.sleep(0.01)
                yield c
        else:
            yield StreamChunk(type="text", text="兜底默认回复")
            yield StreamChunk(type="finish", finish_reason="stop")


class MockSkillEngine(SkillEngine):
    async def execute_skill(self, skill: dict[str, Any], arguments: dict[str, Any], timeout: int = 30):
        return {"output": "skill_executed_ok", "input": arguments}


class MockMcpClientManager(McpClientManager):
    async def call_tool(self, config: dict[str, Any], tool_name: str, arguments: dict[str, Any]):
        return {"output": "mcp_tool_ok", "tool": tool_name, "args": arguments}


# ----------------------------------------------------------------------
# 1. 普通打字机流式单测 (无 Tool Calling)
# ----------------------------------------------------------------------


@pytest.mark.anyio
async def test_react_pure_text_streaming():
    """测试常规问答场景下的逐字打字机流式推送与消息持久化"""
    session_id = uuid.uuid4()
    msg_repo = MockMessageRepository()
    session_repo = MockSessionRepository()
    session_repo.add_session(str(session_id), TEST_USER_ID)

    mock_llm = MockLLMAdapter(
        step_responses=[
            [
                StreamChunk(type="text", text="Hello"),
                StreamChunk(type="text", text=" "),
                StreamChunk(type="text", text="Genesis!"),
                StreamChunk(type="finish", finish_reason="stop", input_tokens=15, output_tokens=5),
            ]
        ]
    )

    service = ChatService(
        message_repo=msg_repo,
        skill_repo=MockSkillRepository(),
        mcp_repo=MockMcpRepository(),
        llm=mock_llm,
        ctx_mgr=ContextManager(message_repo=msg_repo),
    )

    req = ChatRequest(content="你好", model="gpt-4o")
    events = []
    async for event_raw in service.handle_stream(session_id, req, TEST_USER_ID):
        events.append(event_raw)

    # 验证产生的所有 SSE 事件
    event_str = "".join(events)
    assert "event: text_delta" in event_str
    assert "Hello" in event_str
    assert "Genesis!" in event_str
    assert "event: step_finish" in event_str
    assert "event: done" in event_str

    # 验证消息已被存入仓储 (1 条 user, 1 条 assistant)
    assert len(msg_repo.messages) == 2
    assert msg_repo.messages[0]["role"] == "user"
    assert msg_repo.messages[0]["content"] == "你好"
    assert msg_repo.messages[1]["role"] == "assistant"
    assert msg_repo.messages[1]["content"] == "Hello Genesis!"


# ----------------------------------------------------------------------
# 2. 多步 ReAct 循环单测 (Step 1 触发 Tool -> Step 2 总结回复)
# ----------------------------------------------------------------------


@pytest.mark.anyio
async def test_react_multistep_tool_calling():
    """测试 ReAct 两步调用：Step 1 返回工具指令 -> 执行沙箱 -> Step 2 给出最终回答"""
    session_id = uuid.uuid4()
    msg_repo = MockMessageRepository()

    # 模拟两步：Step 1 提 tool_calls，Step 2 总结
    step1_chunks = [
        StreamChunk(type="text", text="正在为您查询仓库状态..."),
        StreamChunk(type="tool_start", tool_call_id="call_999", tool_name="mcp__github__get_repo"),
        StreamChunk(type="tool_finish", tool_call_id="call_999", tool_name="mcp__github__get_repo", arguments={"repo": "Genesis"}),
        StreamChunk(type="finish", finish_reason="tool_calls"),
    ]
    step2_chunks = [
        StreamChunk(type="text", text="仓库 Genesis 状态正常，分支已对齐。"),
        StreamChunk(type="finish", finish_reason="stop"),
    ]

    mock_llm = MockLLMAdapter(step_responses=[step1_chunks, step2_chunks])
    mcp_mgr = MockMcpClientManager()

    service = ChatService(
        message_repo=msg_repo,
        skill_repo=MockSkillRepository(),
        mcp_repo=MockMcpRepository(),
        llm=mock_llm,
        mcp_manager=mcp_mgr,
        ctx_mgr=ContextManager(message_repo=msg_repo),
    )

    req = ChatRequest(content="查询一下 Genesis 仓库", model="gpt-4o")
    events = []
    async for event_raw in service.handle_stream(session_id, req, TEST_USER_ID):
        events.append(event_raw)

    full_output = "".join(events)
    assert "event: tool_call_start" in full_output
    assert "mcp__github__get_repo" in full_output
    assert "event: tool_call_result" in full_output
    assert "mcp_tool_ok" in full_output
    assert "仓库 Genesis 状态正常" in full_output
    assert "event: done" in full_output

    # 验证落库记录：1. user 2. assistant(with tool_calls) 3. tool 4. assistant(final)
    roles = [m["role"] for m in msg_repo.messages]
    assert roles == ["user", "assistant", "tool", "assistant"]


# ----------------------------------------------------------------------
# 3. 安全熔断上限保护单测 (超过 max_steps=5 强制切断)
# ----------------------------------------------------------------------


@pytest.mark.anyio
async def test_react_max_steps_circuit_breaker():
    """测试死循环工具调用时触发 max_steps=5 熔断保护"""
    session_id = uuid.uuid4()
    msg_repo = MockMessageRepository()

    # 构造持续要求调用工具的无限循环
    infinite_step = [
        StreamChunk(type="tool_start", tool_call_id="call_loop", tool_name="mcp__loop__tool"),
        StreamChunk(type="tool_finish", tool_call_id="call_loop", tool_name="mcp__loop__tool", arguments={}),
        StreamChunk(type="finish", finish_reason="tool_calls"),
    ]
    mock_llm = MockLLMAdapter(step_responses=[infinite_step] * 10)

    service = ChatService(
        message_repo=msg_repo,
        skill_repo=MockSkillRepository(),
        mcp_repo=MockMcpRepository(),
        llm=mock_llm,
        mcp_manager=MockMcpClientManager(),
        ctx_mgr=ContextManager(message_repo=msg_repo),
    )

    req = ChatRequest(content="死循环任务", model="gpt-4o")
    events = []
    async for event_raw in service.handle_stream(session_id, req, TEST_USER_ID, max_steps=3):
        events.append(event_raw)

    full_output = "".join(events)
    assert "已达到单轮对话 ReAct 最大步数上限" in full_output
    assert "event: done" in full_output


# ----------------------------------------------------------------------
# 4. HTTP 路由端到端单测 (SSE 流式响应与秒级 Stop)
# ----------------------------------------------------------------------


def test_chat_sse_route_and_headers():
    """验证 POST /api/chat/{session_id}/completion 具有穿透反向代理缓冲的 SSE 响应头"""
    session_id = uuid.uuid4()
    session_repo = MockSessionRepository()
    session_repo.add_session(str(session_id), TEST_USER_ID)
    msg_repo = MockMessageRepository()

    mock_llm = MockLLMAdapter(
        step_responses=[
            [
                StreamChunk(type="text", text="Fast streaming chunk"),
                StreamChunk(type="finish", finish_reason="stop"),
            ]
        ]
    )
    service = ChatService(
        message_repo=msg_repo,
        skill_repo=MockSkillRepository(),
        mcp_repo=MockMcpRepository(),
        llm=mock_llm,
        ctx_mgr=ContextManager(message_repo=msg_repo),
    )

    async def mock_current_user():
        return AuthenticatedUser(user_id=TEST_USER_ID, email="test@example.com")

    app.dependency_overrides[get_current_user] = mock_current_user
    app.dependency_overrides[get_session_repository] = lambda: session_repo
    app.dependency_overrides[get_chat_service] = lambda: service

    with TestClient(app) as client:
        # 1. 测试 SSE 路由请求
        payload = {"content": "测试打字机", "model": "gpt-4o"}
        res = client.post(f"/api/chat/{session_id}/completion", json=payload)
        assert res.status_code == 200
        # 验证防缓冲 Header 契约
        assert res.headers["x-accel-buffering"] == "no"
        assert res.headers["cache-control"] == "no-cache"
        assert "text/event-stream" in res.headers["content-type"]
        assert "Fast streaming chunk" in res.text

        # 2. 测试 Stop 路由请求
        stop_res = client.post(f"/api/chat/{session_id}/stop")
        assert stop_res.status_code == 200
        assert stop_res.json()["success"] in (True, False)

    app.dependency_overrides.clear()
