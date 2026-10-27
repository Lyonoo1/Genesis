import asyncio
import json
import os
import tempfile
import uuid
from typing import Any, AsyncGenerator, Optional
from datetime import datetime, timezone

import pytest

from models.schemas.chat import ChatRequest, SSEEventName
from models.schemas.message import MessageCreate
from repositories.session_repository import SessionRepository
from repositories.message_repository import MessageRepository
from repositories.mcp_repository import McpRepository
from repositories.skill_repository import SkillRepository
from services.chat_service import ChatService
from services.context_manager import ContextManager
from services.llm_adapter import LLMAdapter, StreamChunk
from services.mcp_client import McpClientManager
from services.skill_engine import SkillEngine

TEST_USER_ID = "00000000-0000-0000-0000-000000000001"


class MockSessionRepo(SessionRepository):
    def __init__(self):
        super().__init__(client=None)
        self.sessions: dict[str, dict] = {}

    async def get_by_id(self, user_id: str, session_id: uuid.UUID):
        return self.sessions.get(str(session_id))

    def add_session(self, session_id: str, user_id: str):
        self.sessions[session_id] = {
            "id": session_id,
            "user_id": user_id,
            "title": "测试会话",
            "pinned": False,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }


class MockMessageRepo(MessageRepository):
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


class MockLLM(LLMAdapter):
    def __init__(self, step_responses: list[list[StreamChunk]]):
        super().__init__()
        self.step_responses = step_responses
        self.call_count = 0

    async def stream_chat(self, *args, **kwargs) -> AsyncGenerator[StreamChunk, None]:
        if self.call_count < len(self.step_responses):
            chunks = self.step_responses[self.call_count]
            self.call_count += 1
            for c in chunks:
                await asyncio.sleep(0.005)
                yield c
        else:
            yield StreamChunk(type="text", text="流程完成")
            yield StreamChunk(type="finish", finish_reason="stop")


def parse_sse_events(raw_stream: list[str]) -> list[dict[str, Any]]:
    """解析 SSE 原始字符串为结构化字典"""
    events = []
    text = "".join(raw_stream)
    for block in text.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        event_name = None
        data_str = None
        for line in block.split("\n"):
            if line.startswith("event: "):
                event_name = line[7:].strip()
            elif line.startswith("data: "):
                data_str = line[6:].strip()
        if event_name and data_str:
            try:
                events.append({"event": event_name, "data": json.loads(data_str)})
            except Exception:
                events.append({"event": event_name, "data": data_str})
    return events


@pytest.mark.anyio
async def test_workspace_write_file_emits_workbench_file_change():
    """验证 workspace__write_file 成功落盘时触发 workbench_file_change 事件"""
    with tempfile.TemporaryDirectory() as temp_dir:
        session_id = uuid.uuid4()
        session_repo = MockSessionRepo()
        session_repo.add_session(str(session_id), TEST_USER_ID)
        msg_repo = MockMessageRepo()

        # Step 1: LLM 请求调用 workspace__write_file
        step_1 = [
            StreamChunk(
                type="tool_start",
                tool_call_id="call_write_1",
                tool_name="workspace__write_file",
            ),
            StreamChunk(
                type="tool_finish",
                tool_call_id="call_write_1",
                tool_name="workspace__write_file",
                arguments={
                    "path": "src/App.vue",
                    "content": "<template><h1>Hello Genesis</h1></template>",
                    "overwrite": True,
                },
            ),
            StreamChunk(type="finish", finish_reason="tool_calls"),
        ]
        # Step 2: 完成
        step_2 = [
            StreamChunk(type="text", text="代码已成功生成并写入"),
            StreamChunk(type="finish", finish_reason="stop"),
        ]

        mock_llm = MockLLM(step_responses=[step_1, step_2])
        service = ChatService(
            message_repo=msg_repo,
            session_repo=session_repo,
            llm=mock_llm,
            ctx_mgr=ContextManager(message_repo=msg_repo),
        )

        req = ChatRequest(
            content="创建 App.vue",
            model="gpt-4o",
            workspace_path=temp_dir,
        )

        raw_events = []
        async for evt in service.handle_stream(session_id, req, TEST_USER_ID):
            raw_events.append(evt)

        parsed = parse_sse_events(raw_events)
        file_change_events = [e for e in parsed if e["event"] == SSEEventName.WORKBENCH_FILE_CHANGE.value]

        assert len(file_change_events) >= 1
        fc = file_change_events[0]["data"]
        assert fc["path"] == "src/App.vue"
        assert "Hello Genesis" in fc["unified_diff"]
        assert fc["additions"] >= 1


@pytest.mark.anyio
async def test_workspace_edit_file_emits_workbench_file_change():
    """验证 workspace__edit_file 成功局部替换时触发 workbench_file_change 事件"""
    with tempfile.TemporaryDirectory() as temp_dir:
        file_path = os.path.join(temp_dir, "index.js")
        with open(file_path, "w", encoding="utf-8") as f:
            f.write("const title = 'Old Title';\nconsole.log(title);\n")

        session_id = uuid.uuid4()
        session_repo = MockSessionRepo()
        session_repo.add_session(str(session_id), TEST_USER_ID)
        msg_repo = MockMessageRepo()

        # Step 1: LLM 请求调用 workspace__edit_file
        step_1 = [
            StreamChunk(
                type="tool_start",
                tool_call_id="call_edit_1",
                tool_name="workspace__edit_file",
            ),
            StreamChunk(
                type="tool_finish",
                tool_call_id="call_edit_1",
                tool_name="workspace__edit_file",
                arguments={
                    "path": "index.js",
                    "old_string": "const title = 'Old Title';",
                    "new_string": "const title = 'New Title';",
                },
            ),
            StreamChunk(type="finish", finish_reason="tool_calls"),
        ]
        step_2 = [
            StreamChunk(type="text", text="修改完成"),
            StreamChunk(type="finish", finish_reason="stop"),
        ]

        mock_llm = MockLLM(step_responses=[step_1, step_2])
        service = ChatService(
            message_repo=msg_repo,
            session_repo=session_repo,
            llm=mock_llm,
            ctx_mgr=ContextManager(message_repo=msg_repo),
        )

        req = ChatRequest(
            content="修改 index.js 标题",
            model="gpt-4o",
            workspace_path=temp_dir,
        )

        raw_events = []
        async for evt in service.handle_stream(session_id, req, TEST_USER_ID):
            raw_events.append(evt)

        parsed = parse_sse_events(raw_events)
        file_change_events = [e for e in parsed if e["event"] == SSEEventName.WORKBENCH_FILE_CHANGE.value]

        assert len(file_change_events) >= 1
        fc = file_change_events[0]["data"]
        assert fc["path"] == "index.js"
        assert "-const title = 'Old Title';" in fc["unified_diff"]
        assert "+const title = 'New Title';" in fc["unified_diff"]


@pytest.mark.anyio
async def test_workspace_execute_command_emits_workbench_preview():
    """验证 workspace__execute_command 探测到 Web 端口时触发 workbench_preview 事件"""
    with tempfile.TemporaryDirectory() as temp_dir:
        session_id = uuid.uuid4()
        session_repo = MockSessionRepo()
        session_repo.add_session(str(session_id), TEST_USER_ID)
        msg_repo = MockMessageRepo()

        # Step 1: LLM 调用 execute_command 模拟 vite / http-server 端口启动输出
        step_1 = [
            StreamChunk(
                type="tool_start",
                tool_call_id="call_exec_1",
                tool_name="workspace__execute_command",
            ),
            StreamChunk(
                type="tool_finish",
                tool_call_id="call_exec_1",
                tool_name="workspace__execute_command",
                arguments={
                    "command": "echo '  ➜  Local:   http://localhost:5173/'",
                },
            ),
            StreamChunk(type="finish", finish_reason="tool_calls"),
        ]
        step_2 = [
            StreamChunk(type="text", text="服务启动就绪"),
            StreamChunk(type="finish", finish_reason="stop"),
        ]

        mock_llm = MockLLM(step_responses=[step_1, step_2])
        service = ChatService(
            message_repo=msg_repo,
            session_repo=session_repo,
            llm=mock_llm,
            ctx_mgr=ContextManager(message_repo=msg_repo),
        )

        req = ChatRequest(
            content="启动前端服务",
            model="gpt-4o",
            workspace_path=temp_dir,
        )

        raw_events = []
        async for evt in service.handle_stream(session_id, req, TEST_USER_ID):
            raw_events.append(evt)

        parsed = parse_sse_events(raw_events)
        preview_events = [e for e in parsed if e["event"] == SSEEventName.WORKBENCH_PREVIEW.value]

        assert len(preview_events) >= 1
        pv = preview_events[0]["data"]
        assert "5173" in pv["url"]
        assert pv["port"] == 5173


@pytest.mark.anyio
async def test_workspace_execute_command_no_port_no_preview():
    """验证普通的非网络命令不会误发 workbench_preview 事件"""
    with tempfile.TemporaryDirectory() as temp_dir:
        session_id = uuid.uuid4()
        session_repo = MockSessionRepo()
        session_repo.add_session(str(session_id), TEST_USER_ID)
        msg_repo = MockMessageRepo()

        step_1 = [
            StreamChunk(
                type="tool_start",
                tool_call_id="call_exec_plain",
                tool_name="workspace__execute_command",
            ),
            StreamChunk(
                type="tool_finish",
                tool_call_id="call_exec_plain",
                tool_name="workspace__execute_command",
                arguments={"command": "echo 'normal task without port'"},
            ),
            StreamChunk(type="finish", finish_reason="tool_calls"),
        ]
        step_2 = [
            StreamChunk(type="text", text="常规命令执行完成"),
            StreamChunk(type="finish", finish_reason="stop"),
        ]

        mock_llm = MockLLM(step_responses=[step_1, step_2])
        service = ChatService(
            message_repo=msg_repo,
            session_repo=session_repo,
            llm=mock_llm,
            ctx_mgr=ContextManager(message_repo=msg_repo),
        )

        req = ChatRequest(
            content="运行常规命令",
            model="gpt-4o",
            workspace_path=temp_dir,
        )

        raw_events = []
        async for evt in service.handle_stream(session_id, req, TEST_USER_ID):
            raw_events.append(evt)

        parsed = parse_sse_events(raw_events)
        preview_events = [e for e in parsed if e["event"] == SSEEventName.WORKBENCH_PREVIEW.value]
        assert len(preview_events) == 0


@pytest.mark.anyio
async def test_workspace_execute_command_normalizes_0000_url():
    """验证探测到 0.0.0.0 地址时，自动将其规范化为 localhost 供 iframe 访问"""
    with tempfile.TemporaryDirectory() as temp_dir:
        session_id = uuid.uuid4()
        session_repo = MockSessionRepo()
        session_repo.add_session(str(session_id), TEST_USER_ID)
        msg_repo = MockMessageRepo()

        step_1 = [
            StreamChunk(
                type="tool_start",
                tool_call_id="call_exec_0000",
                tool_name="workspace__execute_command",
            ),
            StreamChunk(
                type="tool_finish",
                tool_call_id="call_exec_0000",
                tool_name="workspace__execute_command",
                arguments={
                    "command": "echo 'Server running at http://0.0.0.0:8000/'",
                },
            ),
            StreamChunk(type="finish", finish_reason="tool_calls"),
        ]
        step_2 = [
            StreamChunk(type="text", text="服务启动完毕"),
            StreamChunk(type="finish", finish_reason="stop"),
        ]

        mock_llm = MockLLM(step_responses=[step_1, step_2])
        service = ChatService(
            message_repo=msg_repo,
            session_repo=session_repo,
            llm=mock_llm,
            ctx_mgr=ContextManager(message_repo=msg_repo),
        )

        req = ChatRequest(
            content="启动服务",
            model="gpt-4o",
            workspace_path=temp_dir,
        )

        raw_events = []
        async for evt in service.handle_stream(session_id, req, TEST_USER_ID):
            raw_events.append(evt)

        parsed = parse_sse_events(raw_events)
        preview_events = [e for e in parsed if e["event"] == SSEEventName.WORKBENCH_PREVIEW.value]

        assert len(preview_events) >= 1
        pv = preview_events[0]["data"]
        assert "localhost:8000" in pv["url"]
        assert "0.0.0.0" not in pv["url"]
        assert pv["port"] == 8000
