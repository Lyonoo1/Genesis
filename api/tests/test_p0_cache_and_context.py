import inspect
import json
import uuid
from typing import Any, AsyncGenerator, Optional
import pytest

from models.schemas.chat import ChatRequest
from repositories.message_repository import MessageRepository
from repositories.session_repository import SessionRepository
from repositories.skill_repository import SkillRepository
from repositories.mcp_repository import McpRepository
from services.context_manager import ContextManager, AtomicTurn
from services.llm_adapter import LLMAdapter, StreamChunk
from services.chat_service import ChatService, GREETING_PATTERN


# ----------------------------------------------------------------------
# 任务 1 单测：L1/L2/L3 上下文管理与断链自愈
# ----------------------------------------------------------------------


def test_gate_tool_output_short():
    """短输出不应被截断"""
    short_content = "File created successfully."
    assert ContextManager.gate_tool_output(short_content) == short_content


def test_gate_tool_output_by_lines():
    """超过 500 行的输出：保留前 200 行 + 后 100 行，中间替换为截断占位符"""
    lines = [f"line {i}" for i in range(1, 601)]  # 600 lines
    content = "\n".join(lines)
    result = ContextManager.gate_tool_output(content)

    res_lines = result.split("\n")
    # 前 200 行为 line 1 ~ line 200
    assert res_lines[:200] == lines[:200]
    # 中间为截断标记，包含 omitted lines = 600 - 300 = 300
    assert '<truncated lines="300">[输出过长已截断，请使用 grep_search 或指定行号范围读取]</truncated>' in result
    # 后 100 行为 line 501 ~ line 600
    assert res_lines[-100:] == lines[-100:]


def test_gate_tool_output_by_characters():
    """行数 <= 300 但字符数 > 15,000 的输出：保护性截断"""
    big_chunk = "A" * 20000
    result = ContextManager.gate_tool_output(big_chunk)
    assert len(result) < 20000
    assert '<truncated lines="0">[输出过长已截断，请使用 grep_search 或指定行号范围读取]</truncated>' in result
    assert result.startswith("A" * 7500)
    assert result.endswith("A" * 7500)


def test_build_atomic_turns_and_chain_healing():
    """测试 AtomicTurn 打包、断链自愈与孤立 tool 过滤"""
    ctx_mgr = ContextManager()

    db_messages = [
        # 0. 孤立的 tool 消息（前面无 assistant），应被丢弃
        {"role": "tool", "tool_call_id": "orphan_call", "content": "orphan content"},
        # 1. 正常的 user 消息
        {"role": "user", "content": "初始化项目"},
        # 2. assistant 发出 2 个 tool_calls
        {
            "role": "assistant",
            "content": "正在执行检查",
            "raw_tool_calls": [
                {"id": "call_1", "name": "workspace__read_file", "args": {"path": "a.txt"}},
                {"id": "call_2", "name": "workspace__write_file", "args": {"path": "b.txt"}},
            ],
        },
        # 3. 只有 call_1 的结果（call_2 因取消或拒绝而缺失）
        {"role": "tool", "tool_call_id": "call_1", "content": "content of a.txt"},
        # 4. 后续的用户新指令
        {"role": "user", "content": "下一步"},
    ]

    turns = ctx_mgr.build_atomic_turns(db_messages)

    # 应该有 3 个 Turn: User -> Assistant(含断链自愈 tool) -> User
    assert len(turns) == 3

    # Turn 0: User
    assert turns[0].role == "user"
    assert turns[0].messages[0]["content"] == "初始化项目"

    # Turn 1: Assistant + tool 结果 (包含自愈的 call_2)
    assert turns[1].role == "assistant"
    assert len(turns[1].messages) == 3  # assistant + call_1 + healed call_2
    asst_msg = turns[1].messages[0]
    assert asst_msg["role"] == "assistant"
    assert len(asst_msg["tool_calls"]) == 2

    tool_1 = turns[1].messages[1]
    assert tool_1["role"] == "tool"
    assert tool_1["tool_call_id"] == "call_1"
    assert tool_1["content"] == "content of a.txt"

    tool_2 = turns[1].messages[2]
    assert tool_2["role"] == "tool"
    assert tool_2["tool_call_id"] == "call_2"
    assert tool_2["content"] == "[Execution aborted or rejected by user]"
    assert tool_2["is_error"] is True

    # Turn 2: User
    assert turns[2].role == "user"
    assert turns[2].messages[0]["content"] == "下一步"


def test_l2_micro_compact():
    """测试 L2 微压缩：超过 5 个 Turn 的旧 AtomicTurn 中的超长 tool 输出原地替换"""
    ctx_mgr = ContextManager()

    # 构造 8 个 AtomicTurn
    # Turn 0 ~ Turn 1: 距离最新轮次 (Turn 7) 的距离分别为 7 和 6 (> 5) -> 应压缩
    # Turn 2 ~ Turn 7: 距离分别为 5, 4, 3, 2, 1, 0 (<= 5) -> 不应压缩
    turns: list[AtomicTurn] = []
    long_output = "X" * 3000
    short_output = "Y" * 500

    for i in range(8):
        asst = {"role": "assistant", "content": f"step {i}", "tool_calls": [{"id": f"tc_{i}"}]}
        tool_content = long_output if i in (0, 1, 6) else short_output
        tool_msg = {"role": "tool", "tool_call_id": f"tc_{i}", "content": tool_content}
        turns.append(AtomicTurn(role="assistant", messages=[asst, tool_msg]))

    compacted = ctx_mgr.apply_micro_compact(turns)

    # Turn 0 和 1 距离 > 5 且字符 > 2000，应被替换
    assert compacted[0].messages[1]["content"] == "[Historical tool output cleared to save context. Re-read if needed.]"
    assert compacted[0].messages[1]["tool_call_id"] == "tc_0"
    assert compacted[1].messages[1]["content"] == "[Historical tool output cleared to save context. Re-read if needed.]"

    # Turn 6 字符 > 2000 但距离为 1 (<= 5)，不应被微压缩
    assert compacted[6].messages[1]["content"] == long_output


def test_l3_budget_pruning():
    """测试 L3 预算裁剪：始终保留第 1 条 User 消息（初始任务目标），其余从最新往最旧累加，超出整组丢弃"""
    ctx_mgr = ContextManager()

    # 构造历史：
    # Turn 0: User 初始目标 (100 tokens)
    # Turn 1: Turn 1 (300 tokens)
    # Turn 2: Turn 2 (300 tokens)
    # Turn 3: Turn 3 (300 tokens)
    # Turn 4: Turn 4 最新轮次 (300 tokens)
    turns = [
        AtomicTurn(role="user", messages=[{"role": "user", "content": "A" * 200}]),  # ~100 tokens
        AtomicTurn(role="assistant", messages=[{"role": "assistant", "content": "B" * 600}]),  # ~300 tokens
        AtomicTurn(role="assistant", messages=[{"role": "assistant", "content": "C" * 600}]),  # ~300 tokens
        AtomicTurn(role="assistant", messages=[{"role": "assistant", "content": "D" * 600}]),  # ~300 tokens
        AtomicTurn(role="assistant", messages=[{"role": "assistant", "content": "E" * 600}]),  # ~300 tokens
    ]

    # 总预算设定为 750 tokens:
    # 首条 User 占用 100 tokens -> 剩余预算 650 tokens
    # 最新 Turn 4 占用 300 tokens -> 剩余 350 tokens
    # Turn 3 占用 300 tokens -> 剩余 50 tokens
    # Turn 2 占用 300 tokens -> 超出预算，丢弃 Turn 2 和更早的 Turn 1
    selected = ctx_mgr.apply_budget_pruning(turns, budget=750)

    # 保留了 Turn 0 (首条 User) 以及最新的 Turn 3, Turn 4
    assert len(selected) == 3
    assert selected[0] is turns[0]
    assert selected[1] is turns[3]
    assert selected[2] is turns[4]


# ----------------------------------------------------------------------
# 任务 2 单测：Anthropic 协议转换、4 断点缓存与 OpenAI 推理模型适配
# ----------------------------------------------------------------------


def test_anthropic_role_alternation_and_tool_merging():
    """测试 Anthropic 角色严格交替与多工具返回合并为单条 role: user 消息"""
    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "查一下文件"},
        {
            "role": "assistant",
            "content": None,  # 测试 content 为 None 时绝不能传 None
            "tool_calls": [
                {"id": "call_a", "function": {"name": "read_a", "arguments": json.dumps({"p": "a"})}},
                {"id": "call_b", "function": {"name": "read_b", "arguments": json.dumps({"p": "b"})}},
            ],
        },
        {"role": "tool", "tool_call_id": "call_a", "content": "result A"},
        {"role": "tool", "tool_call_id": "call_b", "content": "result B"},
        {"role": "assistant", "content": "这是查询结果"},
    ]

    system_text, anthropic_messages = LLMAdapter.convert_to_anthropic_messages(messages)

    # 1. 验证 System 提取
    assert system_text == "You are a helpful assistant."

    # 2. 验证消息严格交替与数量: user -> assistant -> user -> assistant (4条)
    roles = [m["role"] for m in anthropic_messages]
    assert roles == ["user", "assistant", "user", "assistant"]

    # 3. 验证 assistant 工具调用 content 不为 None 且包含 tool_use block
    asst_msg = anthropic_messages[1]
    assert isinstance(asst_msg["content"], list)
    assert len(asst_msg["content"]) == 2
    assert asst_msg["content"][0]["type"] == "tool_use"
    assert asst_msg["content"][0]["id"] == "call_a"
    assert asst_msg["content"][0]["input"] == {"p": "a"}
    assert asst_msg["content"][1]["type"] == "tool_use"
    assert asst_msg["content"][1]["id"] == "call_b"

    # 4. 验证多工具合并在单条 role: user 消息内
    tool_user_msg = anthropic_messages[2]
    assert tool_user_msg["role"] == "user"
    assert isinstance(tool_user_msg["content"], list)
    assert len(tool_user_msg["content"]) == 2
    assert tool_user_msg["content"][0]["type"] == "tool_result"
    assert tool_user_msg["content"][0]["tool_use_id"] == "call_a"
    assert tool_user_msg["content"][0]["content"] == "result A"
    assert tool_user_msg["content"][1]["type"] == "tool_result"
    assert tool_user_msg["content"][1]["tool_use_id"] == "call_b"
    assert tool_user_msg["content"][1]["content"] == "result B"


def test_anthropic_4_breakpoints_prompt_caching():
    """测试 Anthropic 4 断点滑动窗口 Prompt Caching 规范"""
    messages = [
        {"role": "system", "content": "System prompt text."},
        {"role": "user", "content": "Question 1"},
        {"role": "assistant", "content": "Answer 1"},
        {"role": "user", "content": "Question 2"},
        {"role": "assistant", "content": "Answer 2"},
        {"role": "user", "content": "Question 3 (latest)"},
    ]

    system_text, anthropic_messages = LLMAdapter.convert_to_anthropic_messages(messages)

    # 验证最后两条 user 消息拥有 cache_control
    user_msgs = [m for m in anthropic_messages if m["role"] == "user"]
    assert len(user_msgs) == 3

    # Question 1 (最老) 不应有 cache_control
    assert "cache_control" not in user_msgs[0]["content"][-1]

    # Question 2 (倒数第二条 user) 应有 cache_control
    assert user_msgs[1]["content"][-1].get("cache_control") == {"type": "ephemeral"}

    # Question 3 (最后一条 user) 应有 cache_control
    assert user_msgs[2]["content"][-1].get("cache_control") == {"type": "ephemeral"}


@pytest.mark.anyio
async def test_openai_reasoning_models_parameter_adaptation(monkeypatch):
    """测试 OpenAI o1/o3/o4 系列模型将 max_tokens 替换为 max_completion_tokens 并剔除 temperature"""
    captured_payload = {}

    class MockStreamResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass

        async def aiter_lines(self):
            yield "data: [DONE]"

    class MockAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass

        def stream(self, method, url, json=None, headers=None):
            nonlocal captured_payload
            captured_payload = json
            return MockStreamResponse()

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)

    adapter = LLMAdapter(openai_key="sk-test-mock")

    # 1. 测试 o3-mini 模型
    async for _ in adapter.stream_chat(
        messages=[{"role": "user", "content": "hi"}],
        model="o3-mini",
        temperature=0.8,
        max_tokens=4000,
    ):
        pass

    assert "max_completion_tokens" in captured_payload
    assert captured_payload["max_completion_tokens"] == 4000
    assert "max_tokens" not in captured_payload
    assert "temperature" not in captured_payload

    # 2. 测试 o1 模型
    async for _ in adapter.stream_chat(
        messages=[{"role": "user", "content": "hi"}],
        model="o1-preview",
        temperature=0.5,
        max_tokens=5000,
    ):
        pass

    assert "max_completion_tokens" in captured_payload
    assert "max_tokens" not in captured_payload
    assert "temperature" not in captured_payload

    # 3. 测试常规 gpt-4o 模型
    async for _ in adapter.stream_chat(
        messages=[{"role": "user", "content": "hi"}],
        model="gpt-4o",
        temperature=0.7,
        max_tokens=2048,
    ):
        pass

    assert "max_tokens" in captured_payload
    assert captured_payload["max_tokens"] == 2048
    assert "max_completion_tokens" not in captured_payload
    assert captured_payload.get("temperature") == 0.7


def test_l3_budget_pruning_small_budget_respects_limit():
    """测试极端小预算时，L3 预算裁剪严格丢弃超出预算的最新轮次，仅保留首条 User 消息"""
    ctx_mgr = ContextManager()
    turns = [
        AtomicTurn(role="user", messages=[{"role": "user", "content": "A" * 200}]),  # ~100 tokens
        AtomicTurn(role="assistant", messages=[{"role": "assistant", "content": "B" * 600}]),  # ~300 tokens
    ]

    # 总预算只有 100 tokens，首条 User 已消耗 100 tokens，历史预算为 0
    selected = ctx_mgr.apply_budget_pruning(turns, budget=100)
    assert len(selected) == 1
    assert selected[0] is turns[0]


def test_build_atomic_turns_preserves_db_failed_status():
    """测试从数据库加载时，status == 'failed' 的 tool 消息自动设置 is_error=True"""
    ctx_mgr = ContextManager()
    db_messages = [
        {"role": "user", "content": "运行命令"},
        {
            "role": "assistant",
            "content": "正在执行",
            "tool_calls": [{"id": "call_fail", "type": "function", "function": {"name": "run", "arguments": "{}"}}],
        },
        {"role": "tool", "tool_call_id": "call_fail", "content": "Permission denied", "status": "failed"},
    ]
    turns = ctx_mgr.build_atomic_turns(db_messages)
    assert len(turns) == 2
    asst_turn = turns[1]
    assert len(asst_turn.messages) == 2
    tool_msg = asst_turn.messages[1]
    assert tool_msg["tool_call_id"] == "call_fail"
    assert tool_msg.get("is_error") is True


def test_estimate_tokens_with_tool_use_block():
    """测试 estimate_tokens 对无 text/content 字段的结构化 block（如 tool_use）准确估算而不是返回 0"""
    block = [{"type": "tool_use", "id": "call_123", "name": "workspace__read_file", "input": {"path": "test.txt"}}]
    tokens = ContextManager.estimate_tokens(block)
    assert tokens > 10


def test_anthropic_system_with_content_blocks():
    """测试 system 消息 content 为 blocks 列表时不会报 TypeError，并能正确提取 text"""
    messages = [
        {"role": "system", "content": [{"type": "text", "text": "System block instruction"}]},
        {"role": "user", "content": "Hello"},
    ]
    system_text, anthropic_messages = LLMAdapter.convert_to_anthropic_messages(messages)
    assert system_text == "System block instruction"
    assert len(anthropic_messages) == 1


def test_anthropic_breakpoint_1_and_2():
    """测试 Anthropic 断点 1 (System) 与断点 2 (Tools) 的构造与唯一性注入"""
    # 1. 断点 1：build_anthropic_system
    sys_blocks = LLMAdapter.build_anthropic_system("You are Genesis.")
    assert isinstance(sys_blocks, list)
    assert len(sys_blocks) == 1
    assert sys_blocks[0]["cache_control"] == {"type": "ephemeral"}
    assert sys_blocks[0]["text"] == "You are Genesis."
    assert LLMAdapter.build_anthropic_system(None) is None

    # 2. 断点 2：convert_to_anthropic_tools (多个工具，清理旧 cache_control，仅最后一个注入)
    raw_tools = [
        {
            "type": "function",
            "function": {"name": "tool_1", "description": "desc 1", "parameters": {"type": "object"}},
            "cache_control": {"type": "ephemeral"},  # 历史旧标记，应被移除
        },
        {
            "name": "tool_2",
            "description": "desc 2",
            "input_schema": {"type": "object"},
            "cache_control": {"type": "ephemeral"},  # 历史旧标记，应被移除
        },
        {
            "type": "function",
            "function": {"name": "tool_3", "description": "desc 3", "parameters": {"type": "object"}},
        },
    ]
    anthropic_tools = LLMAdapter.convert_to_anthropic_tools(raw_tools)
    assert len(anthropic_tools) == 3
    # 工具 1 和工具 2 的 cache_control 应被剥除
    assert "cache_control" not in anthropic_tools[0]
    assert "cache_control" not in anthropic_tools[1]
    # 仅最后一个工具 3 拥有断点 2 的 cache_control
    assert anthropic_tools[2]["cache_control"] == {"type": "ephemeral"}


@pytest.mark.anyio
async def test_anthropic_full_payload_all_4_breakpoints(monkeypatch):
    """测试 Anthropic 完整请求体同时装配全部 4 个缓存断点以及 beta header"""
    captured_payload = {}
    captured_headers = {}

    class MockStreamResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass

        async def aiter_lines(self):
            yield 'data: {"type": "message_start", "message": {"usage": {"input_tokens": 100, "cache_read_input_tokens": 50, "cache_creation_input_tokens": 20}}}'
            yield 'data: {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 15}}'

    class MockAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass

        def stream(self, method, url, json=None, headers=None):
            nonlocal captured_payload, captured_headers
            captured_payload = json
            captured_headers = headers
            return MockStreamResponse()

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)

    adapter = LLMAdapter(anthropic_key="sk-ant-mock-key")
    messages = [
        {"role": "system", "content": "You are a coding agent."},
        {"role": "user", "content": "Task 1: setup"},
        {"role": "assistant", "content": "Setup done."},
        {"role": "user", "content": "Task 2: build"},
        {"role": "assistant", "content": "Build done."},
        {"role": "user", "content": "Task 3: test"},
    ]
    tools = [
        {"type": "function", "function": {"name": "read_file", "parameters": {}}},
        {"type": "function", "function": {"name": "write_file", "parameters": {}}},
    ]

    total_chunks = []
    async for chunk in adapter.stream_chat(
        messages=messages,
        tools=tools,
        model="claude-3-5-sonnet-20241022",
        provider="anthropic",
    ):
        total_chunks.append(chunk)

    # 1. 验证 beta header
    assert captured_headers.get("anthropic-beta") == "prompt-caching-2024-07-31"

    # 2. 统计断点总数
    bp_count = 0
    # 断点 1：system
    assert "system" in captured_payload
    if captured_payload["system"][-1].get("cache_control"):
        bp_count += 1

    # 断点 2：tools
    assert "tools" in captured_payload
    if captured_payload["tools"][-1].get("cache_control"):
        bp_count += 1

    # 断点 3 & 4：最后两条 user 消息
    for m in captured_payload["messages"]:
        if m["role"] == "user" and m.get("content"):
            if m["content"][-1].get("cache_control"):
                bp_count += 1

    assert bp_count == 4, f"Expected 4 cache breakpoints, got {bp_count}"

    # 3. 验证 finish chunk 正确统计缓存 tokens (100 + 50 + 20 = 170)
    finish_chunk = next(c for c in total_chunks if c.type == "finish")
    assert finish_chunk.input_tokens == 170
    assert finish_chunk.output_tokens == 15


@pytest.mark.anyio
async def test_openai_messages_sanitized_of_is_error(monkeypatch):
    """测试发送给 OpenAI 兼容模型时，消息中的非标准 is_error 字段已被清洗"""
    captured_payload = {}

    class MockStreamResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass

        async def aiter_lines(self):
            yield "data: [DONE]"

    class MockAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass

        def stream(self, method, url, json=None, headers=None):
            nonlocal captured_payload
            captured_payload = json
            return MockStreamResponse()

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", MockAsyncClient)

    adapter = LLMAdapter(openai_key="sk-test-mock")
    messages = [
        {"role": "user", "content": "hi"},
        {"role": "tool", "tool_call_id": "call_1", "content": "failed output", "is_error": True},
    ]

    async for _ in adapter.stream_chat(
        messages=messages,
        model="gpt-4o",
    ):
        pass

    assert "messages" in captured_payload
    tool_msg = captured_payload["messages"][1]
    assert "is_error" not in tool_msg
    assert tool_msg["tool_call_id"] == "call_1"


def test_chat_service_max_steps_default():
    """测试 chat_service.handle_stream 默认 max_steps=20"""
    sig = inspect.signature(ChatService.handle_stream)
    assert sig.parameters["max_steps"].default == 20


@pytest.mark.anyio
async def test_chat_service_greeting_preserves_tools(monkeypatch):
    """测试日常问候触发时，chat_service 绝不删除 tools 列表，且向消息末尾追加系统提示"""
    passed_tools = None
    passed_messages = None

    class MockAdapter:
        async def stream_chat(self, messages, tools=None, **kwargs):
            nonlocal passed_tools, passed_messages
            passed_tools = tools
            passed_messages = messages
            yield StreamChunk(type="text", text="你好！有什么我可以帮你的？")
            yield StreamChunk(type="finish", finish_reason="stop")

    service = ChatService(llm=MockAdapter())

    async def mock_resolve_ws(*args, **kwargs):
        return "/tmp/workspace"

    async def mock_collect_tools(user_id):
        tools = [{"type": "function", "function": {"name": "dummy_tool"}}]
        lookup = {"dummy_tool": {"type": "workspace"}}
        return tools, lookup

    async def mock_build_context(*args, **kwargs):
        return [
            {"role": "system", "content": "You are Genesis."},
            {"role": "user", "content": "你好"},
        ]

    service.resolve_workspace_root = mock_resolve_ws
    service.collect_tools = mock_collect_tools
    service.context_manager.build_context = mock_build_context

    class MockSessionRepo:
        async def get_by_id(self, *args, **kwargs):
            return {"title": "已有标题"}

    class MockMessageRepo:
        async def create(self, *args, **kwargs):
            return {"id": "msg_123"}

        async def update(self, *args, **kwargs):
            return {}

    service.session_repo = MockSessionRepo()
    service.message_repo = MockMessageRepo()

    req = ChatRequest(content="你好")
    events = []
    async for evt in service.handle_stream(
        session_id=uuid.uuid4(),
        req=req,
        user_id="user_test",
    ):
        events.append(evt)

    # 验证 tools 依然完整传递给大模型，未被动态清除！
    assert passed_tools is not None
    assert len(passed_tools) == 1
    assert passed_tools[0]["function"]["name"] == "dummy_tool"

    # 验证 user 消息被追加了系统提示
    last_msg = passed_messages[-1]
    assert last_msg["role"] == "user"
    assert "该消息为常规问候，请直接回复，无需调用任何工具" in last_msg["content"]


